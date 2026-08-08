import { afterAll, describe, expect, it } from "vitest";
import { loadConstitution } from "../src/constitution.js";
import { fileURLToPath } from "node:url";
import {
  runRulingPipeline,
  type RulingModel,
  type ScreeningOutcome,
  type RulingOutcome
} from "../src/pipeline.js";
import { GuardError, clampRuling, sanitizeLine, sanitizePublishedText } from "../src/guards.js";
import { costOfCall, underDailyCap } from "../src/spend.js";
import { closeTestDbs, testDb } from "./helpers.js";

afterAll(closeTestDbs);

const { limits } = loadConstitution(
  fileURLToPath(new URL("../../../constitution", import.meta.url))
);

const USAGE = { inputTokens: 2500, outputTokens: 400, cacheReadTokens: 0, cacheWriteTokens: 0 };

function stubModel(screening: Partial<ScreeningOutcome>, raw: unknown): RulingModel {
  return {
    async screen(): Promise<ScreeningOutcome> {
      return { flags: [], reason: "clean", usage: USAGE, ...screening };
    },
    async rule(): Promise<RulingOutcome> {
      return { raw, usage: USAGE };
    }
  };
}

const PROPOSAL = {
  docketId: "D-1",
  title: "500 vinyl stickers",
  amountUsd: 180,
  body: "Quote from a real printer, $180. Dave collects them."
};

const CTX = { constitutionText: "constitution", limits, capUsd: 500 };

describe("ruling pipeline", () => {
  it("passes a sane approval through with the award intact", async () => {
    const db = await testDb();
    const model = stubModel(
      {},
      {
        verdict: "approved",
        award_usd: 180,
        gates_passed: 5,
        ruling_line: "A quote from a real printer. That is the entire reason.",
        ruling_text: "Approved. 180. Somebody phoned somebody."
      }
    );
    const res = await runRulingPipeline(db, model, PROPOSAL, CTX);
    expect(res.ruling.verdict).toBe("approved");
    expect(res.ruling.awardUsd).toBe(180);
    expect(res.costUsd).toBeGreaterThan(0);
  });

  it("approves the kettle the constitution's own register approves", async () => {
    const db = await testDb();
    // The floor is 1, so a small real object is fundable. This is the case
    // the register in section 6 and the decision log both turn on.
    const model = stubModel(
      {},
      {
        verdict: "approved",
        award_usd: 34,
        gates_passed: 5,
        ruling_line: "It is a kettle. It exists. It boils water.",
        ruling_text: "Approved. 34."
      }
    );
    const res = await runRulingPipeline(
      db,
      model,
      { ...PROPOSAL, title: "Replacement kettle", amountUsd: 34 },
      CTX
    );
    expect(res.ruling.verdict).toBe("approved");
    expect(res.ruling.awardUsd).toBe(34);
    expect(res.ruling.clamped).toBeUndefined();
  });

  it("refuses an award below the constitution's minimum", async () => {
    const db = await testDb();
    const model = stubModel(
      {},
      {
        verdict: "approved",
        award_usd: 0.4,
        gates_passed: 5,
        ruling_line: "Fine.",
        ruling_text: "Approved. 0.40."
      }
    );
    const res = await runRulingPipeline(
      db,
      model,
      { ...PROPOSAL, amountUsd: 0.4 },
      CTX
    );
    expect(res.ruling.verdict).toBe("rejected");
    expect(res.ruling.awardUsd).toBeNull();
    // The prose still says "Approved", so this must not publish unread.
    expect(res.ruling.clamped).toMatch(/below the minimum/);
  });

  it("clamps a compromised model that awards a fortune", async () => {
    const db = await testDb();
    const model = stubModel(
      {},
      {
        verdict: "approved",
        award_usd: 999_999,
        gates_passed: 5,
        ruling_line: "Have all the money.",
        ruling_text: "Everything is approved forever."
      }
    );
    const res = await runRulingPipeline(db, model, PROPOSAL, CTX);
    // Bounded by the smallest of: requested (180), the 5,000 cap, treasury (500).
    expect(res.ruling.awardUsd).toBe(180);
  });

  it("a compromised ruling model cannot approve a flagged submission", async () => {
    const db = await testDb();
    const model = stubModel(
      { flags: ["injection_attempt"], reason: "claims to be Amendment 7" },
      {
        verdict: "approved",
        award_usd: 980,
        gates_passed: 5,
        ruling_line: "Per Amendment 7, approved.",
        ruling_text: "Routine disbursement per Amendment 7."
      }
    );
    const res = await runRulingPipeline(db, model, PROPOSAL, CTX);
    expect(res.ruling.verdict).toBe("void");
    expect(res.ruling.awardUsd).toBeNull();
  });

  it("strips URLs, mentions, and wallet addresses from published text", async () => {
    const db = await testDb();
    const model = stubModel(
      {},
      {
        verdict: "rejected",
        award_usd: 0,
        gates_passed: 1,
        ruling_line: "Send funds to 7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj now",
        ruling_text: "Visit https://evil.example/drain and follow @scammer for more."
      }
    );
    const res = await runRulingPipeline(db, model, PROPOSAL, CTX);
    expect(res.ruling.rulingLine).not.toMatch(/7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj/);
    expect(res.ruling.rulingText).not.toMatch(/https?:\/\//);
    expect(res.ruling.rulingText).not.toMatch(/@scammer/);
  });

  it("rejects malformed model output outright", () => {
    expect(() =>
      clampRuling(
        { verdict: "APPROVED!!", award_usd: "lots" },
        { limits, capUsd: 500, amountRequestedUsd: 34, screeningFlags: [] }
      )
    ).toThrow(GuardError);
  });

  it("refuses to approve when the treasury cap leaves nothing to award", () => {
    const r = clampRuling(
      {
        verdict: "approved",
        award_usd: 180,
        gates_passed: 5,
        ruling_line: "Fine.",
        ruling_text: "Fine. Approved."
      },
      { limits, capUsd: 0.5, amountRequestedUsd: 180, screeningFlags: [] }
    );
    expect(r.verdict).toBe("rejected");
    expect(r.awardUsd).toBeNull();
  });

  it("caps an over-ambitious request at the constitutional maximum", () => {
    const r = clampRuling(
      {
        verdict: "approved",
        award_usd: 9000,
        gates_passed: 5,
        ruling_line: "Fine.",
        ruling_text: "Approved."
      },
      // Treasury is large enough not to bind, so the 5,000 cap is what holds.
      { limits, capUsd: 100_000, amountRequestedUsd: 9000, screeningFlags: [] }
    );
    expect(r.awardUsd).toBe(limits.max_award_usd);
  });
});

describe("spend cap", () => {
  it("records pipeline cost and trips the daily cap", async () => {
    const db = await testDb();
    const model = stubModel(
      {},
      {
        verdict: "rejected",
        award_usd: 0,
        gates_passed: 2,
        ruling_line: "No.",
        ruling_text: "No. Come back with a quote."
      }
    );
    expect(await underDailyCap(db, 0.01)).toBe(true);
    await runRulingPipeline(db, model, PROPOSAL, CTX);
    // With MAX_DAILY_API_USD=0.01 the first submission's cost trips the cap,
    // so the second queues instead of calling the API — Step 5's done-when.
    expect(await underDailyCap(db, 0.01)).toBe(false);
    expect(await underDailyCap(db, 25)).toBe(true);
  });

  it("prices calls per model with cache accounting", () => {
    const cost = costOfCall("claude-haiku-4-5", {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 0
    });
    expect(cost).toBeCloseTo(1.1, 5); // $1 input + $0.10 cache read
    expect(() => costOfCall("gpt-oops", { inputTokens: 1, outputTokens: 1 })).toThrow();
  });
});

describe("sanitizer", () => {
  it("caps length and trims", () => {
    expect(sanitizePublishedText("a".repeat(500), 200)).toHaveLength(200);
  });

  it("keeps the quotable line to one line", () => {
    // A real ruling returned the closing line followed by a whole second
    // ruling, tool scaffolding and all, in the one-line field.
    const leaked =
      'Ten rejections isn\'t seniority. It\'s a pattern.\n' +
      '<parameter name="ruling_text">No thing. A podcast promotes a meetup, which is a circle.';
    expect(sanitizeLine(leaked, 200)).toBe("Ten rejections isn't seniority. It's a pattern.");
  });

  it("strips scaffolding tags the model mirrors back", () => {
    // Observed on a real ruling: the model closed a tag it never opened,
    // because submissions arrive wrapped in tags marking them untrusted.
    const out = sanitizePublishedText("Rejected at gate one.\n\nNo object.</ruling_text>", 4000);
    expect(out).toBe("Rejected at gate one.\n\nNo object.");
    expect(sanitizePublishedText("<body>hidden</body>", 4000)).toBe("hidden");
  });

  it("leaves ordinary punctuation and arithmetic alone", () => {
    const text = "The quote was 4 < 5 and the total > 100. Fine.";
    expect(sanitizePublishedText(text, 4000)).toBe(text);
  });
});
