import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { Oracle, SubmissionsPausedError } from "../src/oracle.js";

const CFG = { feeTargetUsd: 0.4, minLiquidityUsd: 15_000, tokenDecimals: 9 };
const T0 = 1_800_000_000_000;

function makeOracle() {
  const db = openDb(":memory:");
  return new Oracle(db, CFG, []);
}

function tick(price: number, liq: number, at: number) {
  return { priceUsd: price, liquidityUsd: liq, source: "test", observedAt: at };
}

describe("price oracle", () => {
  it("fee scales inversely with token price", () => {
    const o = makeOracle();
    o.accept(tick(0.00004, 50_000, T0), T0);
    expect(o.quoteFee(T0).feeBase).toBe(10_000n * 10n ** 9n); // $0.40 / $0.00004

    o.accept(tick(0.00008, 50_000, T0 + 60_000), T0 + 60_000);
    expect(o.quoteFee(T0 + 60_000).feeBase).toBe(5_000n * 10n ** 9n); // price doubled, fee halves
  });

  it("thin liquidity freezes the fee at the last good value", () => {
    const o = makeOracle();
    o.accept(tick(0.00004, 50_000, T0), T0);
    const before = o.quoteFee(T0);
    expect(before.frozen).toBe(false);

    // Liquidity collapses and price halves. An unfrozen quote would be
    // 20,000 tokens; the guard must keep serving 10,000 instead.
    o.accept(tick(0.00002, 1_000, T0 + 60_000), T0 + 60_000);
    const after = o.quoteFee(T0 + 60_000);
    expect(after.frozen).toBe(true);
    expect(after.feeBase).toBe(before.feeBase);
  });

  it("rejects a 10x price spike as a bad tick", () => {
    const o = makeOracle();
    for (let i = 0; i < 6; i++) {
      o.accept(tick(0.00004, 50_000, T0 + i * 60_000), T0 + i * 60_000);
    }
    const spikeAt = T0 + 6 * 60_000;
    o.accept(tick(0.0004, 50_000, spikeAt), spikeAt); // 10x the median

    const q = o.quoteFee(spikeAt);
    expect(q.feeBase).toBe(10_000n * 10n ** 9n); // still priced off the sane tick
    expect(q.priceUsd).toBeCloseTo(0.00004, 6);
  });

  it("pauses submissions rather than quoting from a stale price", () => {
    const o = makeOracle();
    o.accept(tick(0.00004, 50_000, T0), T0);
    expect(() => o.quoteFee(T0 + 31 * 60_000)).toThrow(SubmissionsPausedError);
  });

  it("never quotes a zero, negative, or absurd fee", () => {
    const o = makeOracle();
    o.accept(tick(0, 50_000, T0), T0); // rejected outright
    expect(() => o.quoteFee(T0)).toThrow(SubmissionsPausedError);

    // A price so high the fee would round to zero tokens: clamp refuses,
    // and with no prior good fee submissions pause.
    const o2 = makeOracle();
    o2.accept(tick(5, 50_000, T0), T0);
    expect(() => o2.quoteFee(T0)).toThrow(SubmissionsPausedError);
  });

  it("survives a restart with its last tick and frozen state", () => {
    const db = openDb(":memory:");
    const o = new Oracle(db, CFG, []);
    o.accept(tick(0.00004, 50_000, T0), T0);
    o.accept(tick(0.00004, 1_000, T0 + 60_000), T0 + 60_000); // freeze

    const o2 = new Oracle(db, CFG, []);
    const q = o2.quoteFee(T0 + 120_000);
    expect(q.frozen).toBe(true);
    expect(q.feeBase).toBe(10_000n * 10n ** 9n);
  });
});
