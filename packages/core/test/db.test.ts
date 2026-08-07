import { describe, expect, it } from "vitest";
import {
  allocateDerivationIndex,
  freeDerivationIndex,
  nextDocketNumber,
  openDb
} from "../src/db.js";

describe("database", () => {
  it("migrates clean and round-trips a docket", () => {
    const db = openDb(":memory:");
    db.prepare(
      "INSERT INTO proposals (id, title, amount_gbp, body, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run("p1", "Replacement kettle", 34, "It boils water.", Date.now());

    const feeTokens = (10_000n * 10n ** 9n).toString();
    db.prepare(
      `INSERT INTO dockets (id, proposal_id, deposit_address, derivation_index, fee_tokens,
        fee_usd_target, price_usd_at_quote, quoted_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'awaiting_payment')`
    ).run("D-1", "p1", "addr", 0, feeTokens, 0.4, 0.00004, Date.now());

    const row = db.prepare("SELECT * FROM dockets WHERE id = 'D-1'").get() as {
      fee_tokens: string;
      status: string;
    };
    expect(row.status).toBe("awaiting_payment");
    // Survives as an exact string — the whole point of never touching a JS number.
    expect(BigInt(row.fee_tokens)).toBe(10_000n * 10n ** 9n);
  });

  it("issues sequential docket numbers", () => {
    const db = openDb(":memory:");
    expect(nextDocketNumber(db)).toBe(1);
    expect(nextDocketNumber(db)).toBe(2);
  });

  it("reuses freed derivation indexes lowest-first", () => {
    const db = openDb(":memory:");
    expect(allocateDerivationIndex(db)).toBe(0);
    expect(allocateDerivationIndex(db)).toBe(1);
    expect(allocateDerivationIndex(db)).toBe(2);
    freeDerivationIndex(db, 1);
    expect(allocateDerivationIndex(db)).toBe(1);
    expect(allocateDerivationIndex(db)).toBe(3);
  });
});
