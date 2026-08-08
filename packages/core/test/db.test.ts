import { afterAll, describe, expect, it } from "vitest";
import { allocateDerivationIndex, freeDerivationIndex, nextDocketNumber } from "../src/db.js";
import { closeTestDbs, testDb } from "./helpers.js";

afterAll(closeTestDbs);

describe("database", () => {
  it("migrates clean and round-trips a docket", async () => {
    const db = await testDb();
    await db.run(
      "INSERT INTO proposals (id, title, amount_usd, body, created_at) VALUES ($1, $2, $3, $4, $5)",
      ["p1", "Replacement kettle", 34, "It boils water.", Date.now()]
    );

    const feeTokens = (10_000n * 10n ** 9n).toString();
    await db.run(
      `INSERT INTO dockets (id, proposal_id, deposit_address, derivation_index, fee_tokens,
        fee_usd_target, price_usd_at_quote, quoted_at, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'awaiting_payment')`,
      ["D-1", "p1", "addr", 0, feeTokens, 0.4, 0.00004, Date.now()]
    );

    const row = await db.row<{ fee_tokens: string; status: string }>(
      "SELECT * FROM dockets WHERE id = 'D-1'"
    );
    expect(row!.status).toBe("awaiting_payment");
    // Survives as an exact string — the whole point of never touching a JS number.
    expect(BigInt(row!.fee_tokens)).toBe(10_000n * 10n ** 9n);
  });

  it("keeps millisecond timestamps as numbers, not strings", async () => {
    const db = await testDb();
    const at = 1_800_000_000_123;
    await db.run(
      "INSERT INTO proposals (id, title, amount_usd, body, created_at) VALUES ('p', 't', 1, 'b', $1)",
      [at]
    );
    const row = await db.row<{ created_at: number }>("SELECT created_at FROM proposals");
    // pg hands back int8 as a string unless told otherwise; that would break
    // every arithmetic comparison against Date.now().
    expect(typeof row!.created_at).toBe("number");
    expect(row!.created_at).toBe(at);
  });

  it("issues sequential docket numbers", async () => {
    const db = await testDb();
    expect(await nextDocketNumber(db)).toBe(1);
    expect(await nextDocketNumber(db)).toBe(2);
  });

  it("reuses freed derivation indexes lowest-first", async () => {
    const db = await testDb();
    expect(await allocateDerivationIndex(db)).toBe(0);
    expect(await allocateDerivationIndex(db)).toBe(1);
    expect(await allocateDerivationIndex(db)).toBe(2);
    await freeDerivationIndex(db, 1);
    expect(await allocateDerivationIndex(db)).toBe(1);
    expect(await allocateDerivationIndex(db)).toBe(3);
  });

  it("enforces the foreign key from rulings to dockets", async () => {
    const db = await testDb();
    await expect(
      db.run(
        `INSERT INTO rulings (docket_id, verdict, ruling_line, ruling_text, model, ruled_at, review_status)
         VALUES ('nope', 'rejected', 'l', 't', 'm', 1, 'auto')`
      )
    ).rejects.toThrow();
  });
});
