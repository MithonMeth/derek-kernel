import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { openDb, type DB } from "../src/db.js";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { Runtime } from "../src/runtime.js";
import { FakeChainClient } from "../src/chain.js";
import { HdAddressDeriver } from "../src/deposits.js";
import { createDocket } from "../src/dockets.js";
import { submitClaim, getClaim } from "../src/claims.js";
import type { PostTransport } from "../src/publisher.js";
import type { RulingModel, RulingOutcome, ScreeningOutcome } from "../src/pipeline.js";

const CONSTITUTION_DIR = fileURLToPath(new URL("../../../constitution", import.meta.url));
const SEED = "ab".repeat(32);
const MINT = "So11111111111111111111111111111111111111112";
const USAGE = { inputTokens: 2500, outputTokens: 400, cacheReadTokens: 0, cacheWriteTokens: 0 };

function fakeModel(raw: unknown, flags: string[] = []): RulingModel {
  return {
    async screen(): Promise<ScreeningOutcome> {
      return { flags, reason: flags.length ? "flagged" : "clean", usage: USAGE };
    },
    async rule(): Promise<RulingOutcome> {
      return { raw, usage: USAGE };
    }
  };
}

function build(raw: unknown, env: Record<string, string> = {}, flags: string[] = []) {
  const db = openDb(":memory:");
  const posted: string[] = [];
  const transport: PostTransport = {
    async post(_text, key) {
      posted.push(key);
      return { id: `post-${posted.length}` };
    },
    async find() {
      return null;
    }
  };
  const cfg = loadConfig({
    PAUSED: "false",
    TOKEN_MINT_ADDRESS: MINT,
    TREASURY_ADDRESS: "treasury",
    FAKE_TREASURY_USD: "20000",
    AUTO_APPROVE_UNFLAGGED: "true",
    MAX_DAILY_API_USD: "25",
    ...env
  } as NodeJS.ProcessEnv);
  const chain = new FakeChainClient();
  const runtime = new Runtime(cfg, CONSTITUTION_DIR, createLogger("test"), {
    db,
    chain,
    deriver: new HdAddressDeriver(SEED),
    model: fakeModel(raw, flags),
    transport
  });
  return { runtime, db, chain, posted };
}

function seedProposal(db: DB, id: string, amountGbp: number): string {
  db.prepare(
    "INSERT INTO proposals (id, title, amount_gbp, body, created_at) VALUES (?, ?, ?, ?, ?)"
  ).run(id, "500 vinyl stickers", amountGbp, "Quote from a real printer. Dave collects them.", Date.now());
  return id;
}

// Above the constitution's minimum award of 50.
const AWARD = 180;

const QUOTE = {
  feeBase: 10_000n * 10n ** 9n,
  feeUsdTarget: 0.4,
  priceUsd: 0.00004,
  quotedAt: Date.now(),
  frozen: false
};

describe("runtime end to end", () => {
  it("carries an approval from submission through payment, ruling, claim, and post", async () => {
    const { runtime, db, chain, posted } = build({
      verdict: "approved",
      award_gbp: AWARD,
      gates_passed: 5,
      ruling_line: "A quote from a real printer. That is the entire reason.",
      ruling_text: "Approved. 180.\n\nSomebody phoned somebody."
    });
    // The oracle needs a live tick before a claim can lock a token amount.
    runtime.oracle.accept({ priceUsd: 0.00004, liquidityUsd: 50_000, source: "test", observedAt: Date.now() });

    const docket = createDocket(db, runtime.deriver!, QUOTE, seedProposal(db, "p1", AWARD));
    chain.setBalance(docket.deposit_address, QUOTE.feeBase);

    await runtime.watchCycle();
    expect(
      (db.prepare("SELECT status FROM dockets WHERE id = ?").get(docket.id) as { status: string }).status
    ).toBe("paid");

    await runtime.rulingCycle();
    const ruling = db.prepare("SELECT * FROM rulings WHERE docket_id = ?").get(docket.id) as {
      verdict: string;
      award_gbp: number;
      review_status: string;
      cycle: number;
    };
    expect(ruling.verdict).toBe("approved");
    expect(ruling.award_gbp).toBe(AWARD);
    expect(ruling.cycle).toBe(1);

    // Approved and auto-confirmed → a claim code exists, locked at ruling price.
    const claim = db.prepare("SELECT code, award_tokens FROM claims WHERE verdict_id = ?").get(docket.id) as {
      code: string;
      award_tokens: string;
    };
    expect(claim.code).toMatch(/^[0-9a-f]{32}$/);
    expect(BigInt(claim.award_tokens)).toBeGreaterThan(0n);

    await runtime.publishCycle();
    expect(posted).toEqual([docket.id]);

    const payout = new HdAddressDeriver(SEED).deriveAddress(500);
    submitClaim(db, claim.code, payout);
    expect(getClaim(db, claim.code)!.status).toBe("claimed");
  });

  it("holds an approval for countersign when AUTO_APPROVE_UNFLAGGED is false", async () => {
    const { runtime, db, chain, posted } = build(
      {
        verdict: "approved",
        award_gbp: AWARD,
        gates_passed: 5,
        ruling_line: "Fine.",
        ruling_text: "Approved. 180."
      },
      { AUTO_APPROVE_UNFLAGGED: "false" }
    );
    runtime.oracle.accept({ priceUsd: 0.00004, liquidityUsd: 50_000, source: "test", observedAt: Date.now() });
    const docket = createDocket(db, runtime.deriver!, QUOTE, seedProposal(db, "p1", AWARD));
    chain.setBalance(docket.deposit_address, QUOTE.feeBase);

    await runtime.watchCycle();
    await runtime.rulingCycle();

    expect(
      (db.prepare("SELECT review_status FROM rulings WHERE docket_id = ?").get(docket.id) as {
        review_status: string;
      }).review_status
    ).toBe("pending_review");
    // No claim code, and nothing published, until a human countersigns.
    expect(db.prepare("SELECT COUNT(*) n FROM claims").get()).toEqual({ n: 0 });
    await runtime.publishCycle();
    expect(posted).toEqual([]);
  });

  it("holds a second approval in the same cycle rather than issuing it", async () => {
    const { runtime, db, chain } = build({
      verdict: "approved",
      award_gbp: AWARD,
      gates_passed: 5,
      ruling_line: "Fine.",
      ruling_text: "Approved. 180."
    });
    runtime.oracle.accept({ priceUsd: 0.00004, liquidityUsd: 50_000, source: "test", observedAt: Date.now() });
    for (const id of ["p1", "p2"]) {
      const d = createDocket(db, runtime.deriver!, QUOTE, seedProposal(db, id, AWARD));
      chain.setBalance(d.deposit_address, QUOTE.feeBase);
    }
    await runtime.watchCycle();
    await runtime.rulingCycle();

    // Constitution s7: one approval per cycle. Both rulings stand as
    // approvals, but only the first releases money.
    const rows = db
      .prepare("SELECT docket_id, verdict, review_status FROM rulings ORDER BY docket_id")
      .all() as Array<{ verdict: string; review_status: string }>;
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.verdict === "approved")).toBe(true);
    expect(rows.filter((r) => r.review_status === "auto")).toHaveLength(1);
    expect(rows.filter((r) => r.review_status === "pending_review")).toHaveLength(1);
    expect((db.prepare("SELECT COUNT(*) n FROM claims").get() as { n: number }).n).toBe(1);
  });

  it("judges nothing while paused, and resumes when unpaused at runtime", async () => {
    const { runtime, db, chain } = build(
      {
        verdict: "rejected",
        award_gbp: 0,
        gates_passed: 1,
        ruling_line: "There are nine adjectives and no object.",
        ruling_text: "Rejected at gate one."
      },
      { PAUSED: "true" }
    );
    const docket = createDocket(db, runtime.deriver!, QUOTE, seedProposal(db, "p1", 4800));
    chain.setBalance(docket.deposit_address, QUOTE.feeBase);
    await runtime.watchCycle();

    await runtime.rulingCycle();
    expect(db.prepare("SELECT COUNT(*) n FROM rulings").get()).toEqual({ n: 0 });

    runtime.setPaused(false); // no redeploy, no restart
    await runtime.rulingCycle();
    expect(
      (db.prepare("SELECT verdict FROM rulings WHERE docket_id = ?").get(docket.id) as {
        verdict: string;
      }).verdict
    ).toBe("rejected");
  });

  it("queues rather than judging once the daily API cap is spent", async () => {
    const { runtime, db, chain } = build(
      {
        verdict: "rejected",
        award_gbp: 0,
        gates_passed: 1,
        ruling_line: "No.",
        ruling_text: "Rejected."
      },
      { MAX_DAILY_API_USD: "0.01" }
    );
    for (const id of ["p1", "p2"]) {
      const docket = createDocket(db, runtime.deriver!, QUOTE, seedProposal(db, id, 100));
      chain.setBalance(docket.deposit_address, QUOTE.feeBase);
    }
    await runtime.watchCycle();

    await runtime.rulingCycle();
    // The first submission spends past the cap; the second stays queued.
    expect((db.prepare("SELECT COUNT(*) n FROM rulings").get() as { n: number }).n).toBe(1);
    expect(
      (db.prepare("SELECT COUNT(*) n FROM dockets WHERE status = 'paid'").get() as { n: number }).n
    ).toBe(1);
  });

  it("refuses to boot against a constitution that does not exist", () => {
    expect(
      () =>
        new Runtime(loadConfig({} as NodeJS.ProcessEnv), "/no/such/constitution", createLogger("test"), {
          db: openDb(":memory:")
        })
    ).toThrow();
  });
});
