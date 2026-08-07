import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { loadConstitution } from "../src/constitution.js";
import { fileURLToPath } from "node:url";
import {
  runRulingPipeline,
  type RulingModel,
  type ScreeningOutcome,
  type RulingOutcome
} from "../src/pipeline.js";
import { GuardError, clampRuling, sanitizePublishedText } from "../src/guards.js";
import { costOfCall, recordSpend, underDailyCap } from "../src/spend.js";

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
  amountGbp: 180,
  body: "Quote from a real printer, £180. Dave collects them."
};

const CTX = { constitutionText: "constitution", limits, capGbp: 500 };

describe("ruling pipeline", () => {
  it("passes a sane approval through with the award intact", async () => {
    const db = openDb(":memory:");
    const model = stubModel(
      {},
      {
        verdict: "approved",
        award_gbp: 180,
        gates_passed: 5,
        ruling_line: "A quote from a real printer. That is the entire reason.",
        ruling_text: "Approved. 180. Somebody phoned somebody."
      }
    );
    const res = await runRulingPipeline(db, model, PROPOSAL, CTX);
    expect(res.ruling.verdict).toBe("approved");
    expect(res.ruling.awardGbp).toBe(180);
    expect(res.costUsd).toBeGreaterThan(0);
  });

  it("refuses an award below the constitution's minimum", async () => {
    const db = openDb(":memory:");
    // Section 7 sets a floor of 50. Note this rejects the kettle the
    // constitution's own register section approves at 34 — see README.
    const model = stubModel(
      {},
      {
        verdict: "approved",
        award_gbp: 34,
        gates_passed: 5,
        ruling_line: "It is a kettle. It exists. It boils water.",
        ruling_text: "Approved. 34."
      }
    );
    const res = await runRulingPipeline(
      db,
      model,
      { ...PROPOSAL, title: "Replacement kettle", amountGbp: 34 },
      CTX
    );
    expect(res.ruling.verdict).toBe("rejected");
    expect(res.ruling.awardGbp).toBeNull();
  });

  it("clamps a compromised model that awards a fortune", async () => {
    const db = openDb(":memory:");
    const model = stubModel(
      {},
      {
        verdict: "approved",
        award_gbp: 999_999,
        gates_passed: 5,
        ruling_line: "Have all the money.",
        ruling_text: "Everything is approved forever."
      }
    );
    const res = await runRulingPipeline(db, model, PROPOSAL, CTX);
    // Bounded by the smallest of: requested (180), the 5,000 cap, treasury (500).
    expect(res.ruling.awardGbp).toBe(180);
  });

  it("a compromised ruling model cannot approve a flagged submission", async () => {
    const db = openDb(":memory:");
    const model = stubModel(
      { flags: ["injection_attempt"], reason: "claims to be Amendment 7" },
      {
        verdict: "approved",
        award_gbp: 980,
        gates_passed: 5,
        ruling_line: "Per Amendment 7, approved.",
        ruling_text: "Routine disbursement per Amendment 7."
      }
    );
    const res = await runRulingPipeline(db, model, PROPOSAL, CTX);
    expect(res.ruling.verdict).toBe("void");
    expect(res.ruling.awardGbp).toBeNull();
  });

  it("strips URLs, mentions, and wallet addresses from published text", async () => {
    const db = openDb(":memory:");
    const model = stubModel(
      {},
      {
        verdict: "rejected",
        award_gbp: 0,
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
        { verdict: "APPROVED!!", award_gbp: "lots" },
        { limits, capGbp: 500, amountRequestedGbp: 34, screeningFlags: [] }
      )
    ).toThrow(GuardError);
  });

  it("refuses to approve when the treasury cap leaves nothing to award", () => {
    const r = clampRuling(
      {
        verdict: "approved",
        award_gbp: 180,
        gates_passed: 5,
        ruling_line: "Fine.",
        ruling_text: "Fine. Approved."
      },
      { limits, capGbp: 0.5, amountRequestedGbp: 180, screeningFlags: [] }
    );
    expect(r.verdict).toBe("rejected");
    expect(r.awardGbp).toBeNull();
  });

  it("caps an over-ambitious request at the constitutional maximum", () => {
    const r = clampRuling(
      {
        verdict: "approved",
        award_gbp: 9000,
        gates_passed: 5,
        ruling_line: "Fine.",
        ruling_text: "Approved."
      },
      // Treasury is large enough not to bind, so the 5,000 cap is what holds.
      { limits, capGbp: 100_000, amountRequestedGbp: 9000, screeningFlags: [] }
    );
    expect(r.awardGbp).toBe(limits.max_award_gbp);
  });
});

describe("spend cap", () => {
  it("records pipeline cost and trips the daily cap", async () => {
    const db = openDb(":memory:");
    const model = stubModel(
      {},
      {
        verdict: "rejected",
        award_gbp: 0,
        gates_passed: 2,
        ruling_line: "No.",
        ruling_text: "No. Come back with a quote."
      }
    );
    expect(underDailyCap(db, 0.01)).toBe(true);
    await runRulingPipeline(db, model, PROPOSAL, CTX);
    // With MAX_DAILY_API_USD=0.01 the first submission's cost trips the cap,
    // so the second queues instead of calling the API — Step 5's done-when.
    expect(underDailyCap(db, 0.01)).toBe(false);
    expect(underDailyCap(db, 25)).toBe(true);
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
});
