import { afterAll, describe, expect, it } from "vitest";
import type { DB } from "../src/db.js";
import { FakeChainClient } from "../src/chain.js";
import { HdAddressDeriver } from "../src/deposits.js";
import { loadConstitution } from "../src/constitution.js";
import { fileURLToPath } from "node:url";
import {
  planSweeps,
  runSweep,
  splitFee,
  SweepConfigError,
  type SweepExecutor,
  type SweepPlan
} from "../src/sweeper.js";
import { Runtime } from "../src/runtime.js";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { closeTestDbs, testDb } from "./helpers.js";

const { limits } = loadConstitution(
  fileURLToPath(new URL("../../../constitution", import.meta.url))
);
const SPLIT = limits.fee_split; // 50 / 35 / 15
const SEED = "ab".repeat(32);
const MINT = "So11111111111111111111111111111111111111112";
const T0 = 1_800_000_000_000;
const UNIT = 10n ** 9n;
const DUST = 1n * UNIT;

afterAll(closeTestDbs);

function recordingExecutor(fail: Set<string> = new Set()) {
  const sent: SweepPlan[] = [];
  const seeds: string[] = [];
  const executor: SweepExecutor = {
    async execute(plan, seed) {
      if (fail.has(plan.docketId)) throw new Error("rpc exploded");
      sent.push(plan);
      seeds.push(seed.toString("hex"));
      return `sig-${plan.docketId}`;
    }
  };
  return { executor, sent, seeds };
}

async function seedPaidDocket(
  db: DB,
  deriver: HdAddressDeriver,
  id: string,
  index: number,
  at = T0
): Promise<string> {
  const address = deriver.deriveAddress(index);
  await db.run(
    "INSERT INTO proposals (id, title, amount_gbp, body, created_at) VALUES ($1, 't', 100, 'b', $2)",
    ["p" + id, at]
  );
  await db.run(
    `INSERT INTO dockets (id, proposal_id, deposit_address, derivation_index, fee_tokens,
       fee_usd_target, price_usd_at_quote, quoted_at, paid_at, status)
     VALUES ($1, $2, $3, $4, '1', 0.4, 0.00004, $5, $5, 'judged')`,
    [id, "p" + id, address, index, at]
  );
  return address;
}

describe("fee split", () => {
  it("splits exactly, with no tokens created or destroyed", () => {
    for (const total of [0n, 1n, 7n, 999n, 10_000n * UNIT, 123_456_789n]) {
      const s = splitFee(total, SPLIT);
      expect(s.burn + s.treasury + s.ops).toBe(total);
      expect(s.burn).toBeGreaterThanOrEqual(0n);
      expect(s.treasury).toBeGreaterThanOrEqual(0n);
      expect(s.ops).toBeGreaterThanOrEqual(0n);
    }
  });

  it("gives the remainder to the Treasury rather than rounding it away", () => {
    // 7 base units at 50/35/15: burn 3, ops 1, and the odd 3 must land
    // somewhere rather than vanish.
    const s = splitFee(7n, SPLIT);
    expect(s.burn).toBe(3n);
    expect(s.ops).toBe(1n);
    expect(s.treasury).toBe(3n);
    expect(s.burn + s.treasury + s.ops).toBe(7n);
  });

  it("burns half of a whole fee", () => {
    const s = splitFee(10_000n * UNIT, SPLIT);
    expect(s.burn).toBe(5_000n * UNIT);
    expect(s.treasury).toBe(3_500n * UNIT);
    expect(s.ops).toBe(1_500n * UNIT);
  });

  it("refuses a negative balance or a nonsense split", () => {
    expect(() => splitFee(-1n, SPLIT)).toThrow(SweepConfigError);
    expect(() => splitFee(100n, { burn: 0.9, treasury: 0.9, ops: 0.9 })).toThrow(SweepConfigError);
  });
});

describe("sweeping", () => {
  it("moves what is actually there, not what was quoted", async () => {
    const db = await testDb();
    const deriver = new HdAddressDeriver(SEED);
    const address = await seedPaidDocket(db, deriver, "D-1", 0);
    const chain = new FakeChainClient();
    // Quoted fee was 1 base unit; they actually sent 10,000 whole tokens.
    chain.setBalance(address, 10_000n * UNIT);

    const { executor, sent } = recordingExecutor();
    const done = await runSweep({
      db, chain, executor, deriveSigningSeed: (i) => deriver.deriveSigningSeed(i),
      mint: MINT, limits, dustBase: DUST
    });

    expect(done).toEqual([{ docketId: "D-1", signature: "sig-D-1" }]);
    expect(sent[0].total).toBe(10_000n * UNIT);
    expect(sent[0].burn).toBe(5_000n * UNIT);
  });

  it("signs with the key that controls the advertised address", async () => {
    const db = await testDb();
    const deriver = new HdAddressDeriver(SEED);
    await seedPaidDocket(db, deriver, "D-1", 4);
    const chain = new FakeChainClient();
    chain.setBalance(deriver.deriveAddress(4), 5_000n * UNIT);

    const { executor, seeds } = recordingExecutor();
    await runSweep({
      db, chain, executor, deriveSigningSeed: (i) => deriver.deriveSigningSeed(i),
      mint: MINT, limits, dustBase: DUST
    });
    expect(seeds[0]).toBe(deriver.deriveSigningSeed(4).toString("hex"));
  });

  it("never sweeps the same balance twice", async () => {
    const db = await testDb();
    const deriver = new HdAddressDeriver(SEED);
    const address = await seedPaidDocket(db, deriver, "D-1", 0);
    const chain = new FakeChainClient();
    chain.setBalance(address, 10_000n * UNIT);

    const first = recordingExecutor();
    await runSweep({
      db, chain, executor: first.executor, deriveSigningSeed: (i) => deriver.deriveSigningSeed(i),
      mint: MINT, limits, dustBase: DUST
    });

    const second = recordingExecutor();
    await runSweep({
      db, chain, executor: second.executor, deriveSigningSeed: (i) => deriver.deriveSigningSeed(i),
      mint: MINT, limits, dustBase: DUST
    });
    expect(second.sent).toHaveLength(0);
  });

  it("leaves a failed sweep to be retried, and does not mark it done", async () => {
    const db = await testDb();
    const deriver = new HdAddressDeriver(SEED);
    const address = await seedPaidDocket(db, deriver, "D-1", 0);
    const chain = new FakeChainClient();
    chain.setBalance(address, 10_000n * UNIT);

    const failing = recordingExecutor(new Set(["D-1"]));
    const done = await runSweep({
      db, chain, executor: failing.executor, deriveSigningSeed: (i) => deriver.deriveSigningSeed(i),
      mint: MINT, limits, dustBase: DUST
    });
    expect(done).toHaveLength(0);
    const row = await db.row<{ swept_at: number | null }>(
      "SELECT swept_at FROM dockets WHERE id = 'D-1'"
    );
    expect(row!.swept_at).toBeNull();

    // The retry succeeds and still moves the full balance.
    const retry = recordingExecutor();
    await runSweep({
      db, chain, executor: retry.executor, deriveSigningSeed: (i) => deriver.deriveSigningSeed(i),
      mint: MINT, limits, dustBase: DUST
    });
    expect(retry.sent[0].total).toBe(10_000n * UNIT);
  });

  it("a crash after sending cannot double-spend, because the balance is re-read", async () => {
    const db = await testDb();
    const deriver = new HdAddressDeriver(SEED);
    const address = await seedPaidDocket(db, deriver, "D-1", 0);
    const chain = new FakeChainClient();
    chain.setBalance(address, 10_000n * UNIT);

    // Executor sends successfully, then the process dies before swept_at is
    // written — simulated by draining the balance and leaving the row alone.
    const drained: SweepExecutor = {
      async execute(plan) {
        chain.setBalance(plan.address, 0n);
        throw new Error("died after send");
      }
    };
    await runSweep({
      db, chain, executor: drained, deriveSigningSeed: (i) => deriver.deriveSigningSeed(i),
      mint: MINT, limits, dustBase: DUST
    });

    const next = recordingExecutor();
    await runSweep({
      db, chain, executor: next.executor, deriveSigningSeed: (i) => deriver.deriveSigningSeed(i),
      mint: MINT, limits, dustBase: DUST
    });
    // Nothing left to move, so the retry sends no second transaction.
    expect(next.sent).toHaveLength(0);
    const row = await db.row<{ swept_at: number | null }>(
      "SELECT swept_at FROM dockets WHERE id = 'D-1'"
    );
    expect(row!.swept_at).not.toBeNull();
  });

  it("ignores unpaid dockets entirely", async () => {
    const db = await testDb();
    const deriver = new HdAddressDeriver(SEED);
    await db.run(
      "INSERT INTO proposals (id, title, amount_gbp, body, created_at) VALUES ('p', 't', 1, 'b', $1)",
      [T0]
    );
    await db.run(
      `INSERT INTO dockets (id, proposal_id, deposit_address, derivation_index, fee_tokens,
         fee_usd_target, price_usd_at_quote, quoted_at, status)
       VALUES ('D-9', 'p', $1, 0, '1', 0.4, 0.00004, $2, 'awaiting_payment')`,
      [deriver.deriveAddress(0), T0]
    );
    const chain = new FakeChainClient();
    chain.setBalance(deriver.deriveAddress(0), 10_000n * UNIT); // someone sent early

    const plans = await planSweeps(db, chain, MINT, limits, DUST);
    expect(plans).toHaveLength(0);
  });

  it("writes off dust rather than paying a fee to move it", async () => {
    const db = await testDb();
    const deriver = new HdAddressDeriver(SEED);
    const address = await seedPaidDocket(db, deriver, "D-1", 0);
    const chain = new FakeChainClient();
    chain.setBalance(address, DUST); // exactly at the threshold

    const { executor, sent } = recordingExecutor();
    await runSweep({
      db, chain, executor, deriveSigningSeed: (i) => deriver.deriveSigningSeed(i),
      mint: MINT, limits, dustBase: DUST
    });
    expect(sent).toHaveLength(0);
    // Marked so it stops being reconsidered on every future pass.
    const row = await db.row<{ swept_at: number | null }>(
      "SELECT swept_at FROM dockets WHERE id = 'D-1'"
    );
    expect(row!.swept_at).not.toBeNull();
  });

  it("refuses to build an executor on half-configured money settings", async () => {
    const db = await testDb();
    const base = {
      DATABASE_URL: "postgres://x", PAUSED: "true",
      SWEEP_FEE_PAYER_SECRET: "3Kq8xhbvJ1nQ2wFqvV6mYtLxvJ8T5rN9pXcW4dEeAaBbCcDd"
    };
    const make = async (extra: Record<string, string>) =>
      Runtime.create(
        loadConfig({ ...base, ...extra } as NodeJS.ProcessEnv),
        fileURLToPath(new URL("../../../constitution", import.meta.url)),
        createLogger("test"),
        { db, chain: null, deriver: null, model: null, transport: null }
      );

    // Fee payer present but no destinations: stop, rather than send tokens
    // to an address that has not been configured.
    const partial = await make({ RPC_URL: "https://rpc.example" });
    expect(() => partial.sweepExecutor()).toThrow(SweepConfigError);

    // Nothing configured at all is simply "not switched on yet", not an error.
    const off = await make({ SWEEP_FEE_PAYER_SECRET: "" });
    expect(off.sweepExecutor()).toBeNull();
  });

  it("keeps going when one docket's balance check fails", async () => {
    const db = await testDb();
    const deriver = new HdAddressDeriver(SEED);
    await seedPaidDocket(db, deriver, "D-1", 0, T0);
    const good = await seedPaidDocket(db, deriver, "D-2", 1, T0 + 1000);

    const chain = new FakeChainClient();
    chain.setBalance(good, 10_000n * UNIT);
    const original = chain.getTokenBalanceBase.bind(chain);
    chain.getTokenBalanceBase = async (owner: string) => {
      if (owner === deriver.deriveAddress(0)) throw new Error("rpc timeout");
      return original(owner);
    };

    const { executor, sent } = recordingExecutor();
    await runSweep({
      db, chain, executor, deriveSigningSeed: (i) => deriver.deriveSigningSeed(i),
      mint: MINT, limits, dustBase: DUST
    });
    expect(sent.map((p) => p.docketId)).toEqual(["D-2"]);
  });
});
