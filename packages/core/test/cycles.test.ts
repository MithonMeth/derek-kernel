import { afterAll, describe, expect, it } from "vitest";
import type { DB } from "../src/db.js";
import {
  currentCycle,
  cycleOf,
  cycleSlotFree,
  daysSinceLastApproval,
  issuedApprovalsInCycle
} from "../src/cycles.js";
import { closeTestDbs, testDb } from "./helpers.js";

const DAY = 86_400_000;
const T0 = 1_800_000_000_000;

afterAll(closeTestDbs);

async function seedRuling(
  db: DB,
  id: string,
  verdict: string,
  cycle: number,
  review: string,
  at = T0
): Promise<void> {
  await db.run(
    "INSERT INTO proposals (id, title, amount_usd, body, created_at) VALUES ($1, 't', 100, 'b', $2)",
    ["p" + id, at]
  );
  await db.run(
    `INSERT INTO dockets (id, proposal_id, deposit_address, derivation_index, fee_tokens,
       fee_usd_target, price_usd_at_quote, quoted_at, status)
     VALUES ($1, $2, 'addr' || $1, 0, '1', 0.4, 0.00004, $3, 'judged')`,
    [id, "p" + id, at]
  );
  await db.run(
    `INSERT INTO rulings (docket_id, verdict, award_usd, ruling_line, ruling_text, model,
       ruled_at, review_status, cycle)
     VALUES ($1, $2, 100, 'line', 'text', 'test', $3, $4, $5)`,
    [id, verdict, at, review, cycle]
  );
}

describe("cycles", () => {
  it("starts at cycle 1 and advances one per day", async () => {
    const db = await testDb();
    expect(await currentCycle(db, T0)).toBe(1);
    expect(await currentCycle(db, T0 + DAY)).toBe(2);
    expect(await currentCycle(db, T0 + 46 * DAY)).toBe(47);
    // The epoch is pinned on first use, so later calls do not re-anchor it.
    expect(await currentCycle(db, T0)).toBe(1);
  });

  it("dates a past ruling into the cycle it was issued in", async () => {
    const db = await testDb();
    await currentCycle(db, T0);
    expect(await cycleOf(db, T0 + 3 * DAY, T0 + 9 * DAY)).toBe(4);
  });

  it("counts only issued approvals against the cycle's single slot", async () => {
    const db = await testDb();
    const limit = 1;
    expect(await cycleSlotFree(db, 1, limit)).toBe(true);

    // Held for countersign: the ruling stands but no money moved, so the
    // slot stays open rather than being blocked by a pending decision.
    await seedRuling(db, "D-1", "approved", 1, "pending_review");
    expect(await issuedApprovalsInCycle(db, 1)).toBe(0);
    expect(await cycleSlotFree(db, 1, limit)).toBe(true);

    await seedRuling(db, "D-2", "approved", 1, "auto");
    expect(await issuedApprovalsInCycle(db, 1)).toBe(1);
    expect(await cycleSlotFree(db, 1, limit)).toBe(false);

    // Rejections never consume the slot, and the next cycle is untouched.
    await seedRuling(db, "D-3", "rejected", 1, "auto");
    expect(await issuedApprovalsInCycle(db, 1)).toBe(1);
    expect(await cycleSlotFree(db, 2, limit)).toBe(true);
  });

  it("counts a countersigned approval once confirmed", async () => {
    const db = await testDb();
    await seedRuling(db, "D-1", "approved", 1, "pending_review");
    expect(await cycleSlotFree(db, 1, 1)).toBe(true);
    await db.run("UPDATE rulings SET review_status = 'confirmed' WHERE docket_id = 'D-1'");
    expect(await cycleSlotFree(db, 1, 1)).toBe(false);
  });

  it("reports days since the last issued approval", async () => {
    const db = await testDb();
    expect(await daysSinceLastApproval(db, T0)).toBeNull();
    await seedRuling(db, "D-1", "approved", 1, "auto", T0);
    expect(await daysSinceLastApproval(db, T0 + 23 * DAY)).toBe(23);
    // A held approval is not an approval yet, so the counter keeps running.
    await seedRuling(db, "D-2", "approved", 24, "pending_review", T0 + 23 * DAY);
    expect(await daysSinceLastApproval(db, T0 + 23 * DAY)).toBe(23);
  });
});
