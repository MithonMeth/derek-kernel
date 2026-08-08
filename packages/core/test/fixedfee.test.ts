import { afterAll, describe, expect, it } from "vitest";
import { Oracle } from "../src/oracle.js";
import { createLogger } from "../src/logger.js";
import { closeTestDbs, testDb } from "./helpers.js";

afterAll(closeTestDbs);

const BASE = { minLiquidityUsd: 15_000, tokenDecimals: 6 };

async function oracle(feeFixedTokens?: number) {
  const db = await testDb();
  return Oracle.create(db, { feeTargetUsd: 2, feeFixedTokens, ...BASE }, [], createLogger("test"));
}

describe("flat token fee", () => {
  it("quotes without any price at all", async () => {
    // The case this exists for: a token with no market yet. The dollar path
    // throws here, because there is nothing defensible to price against.
    const o = await oracle(1_000_000);
    const q = await o.quoteFee();
    expect(q.feeBase).toBe(1_000_000n * 10n ** 6n);
    expect(q.frozen).toBe(false);
  });

  it("the dollar path still refuses when there is no price", async () => {
    const o = await oracle(undefined);
    await expect(o.quoteFee()).rejects.toThrow();
  });

  it("ignores a liquidity floor breach, having nothing to price against", async () => {
    const o = await oracle(1_000_000);
    await o.accept({ priceUsd: 0.000002253, liquidityUsd: 0, source: "t", observedAt: Date.now() });
    const q = await o.quoteFee();
    expect(q.feeBase).toBe(1_000_000n * 10n ** 6n);
    expect(q.frozen).toBe(false);
  });

  it("charges the same tokens however the price moves", async () => {
    const o = await oracle(1_000_000);
    const seen: bigint[] = [];
    for (const priceUsd of [0.000002, 0.00002, 0.002]) {
      await o.accept({ priceUsd, liquidityUsd: 50_000, source: "t", observedAt: Date.now() });
      seen.push((await o.quoteFee()).feeBase);
    }
    // The deliberate consequence: a flat fee does NOT hold its dollar cost
    // as the coin moves. That is the trade for working without a market.
    expect(new Set(seen.map(String)).size).toBe(1);
  });

  it("reports what the flat fee is worth today, without deriving from it", async () => {
    const o = await oracle(1_000_000);
    await o.accept({ priceUsd: 0.000002, liquidityUsd: 50_000, source: "t", observedAt: Date.now() });
    expect((await o.quoteFee()).feeUsdTarget).toBeCloseTo(2, 6);
  });
});
