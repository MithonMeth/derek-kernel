import { describe, expect, it } from "vitest";
import { openDb, type DB } from "../src/db.js";
import {
  currentCycle,
  cycleOf,
  cycleSlotFree,
  daysSinceLastApproval,
  issuedApprovalsInCycle
} from "../src/cycles.js";

const DAY = 86_400_000;
const T0 = 1_800_000_000_000; // a fixed instant, mid-UTC-day

function seedRuling(
  db: DB,
  id: string,
  verdict: string,
  cycle: number,
  review: string,
  at = T0
): void {
  db.prepare(
    "INSERT INTO proposals (id, title, amount_gbp, body, created_at) VALUES (?, 't', 100, 'b', ?)"
  ).run("p" + id, at);
  db.prepare(
    `INSERT INTO dockets (id, proposal_id, deposit_address, derivation_index, fee_tokens,
       fee_usd_target, price_usd_at_quote, quoted_at, status)
     VALUES (?, ?, 'addr' || ?, 0, '1', 0.4, 0.00004, ?, 'judged')`
  ).run(id, "p" + id, id, at);
  db.prepare(
    `INSERT INTO rulings (docket_id, verdict, award_gbp, ruling_line, ruling_text, model,
       ruled_at, review_status, cycle)
     VALUES (?, ?, 100, 'line', 'text', 'test', ?, ?, ?)`
  ).run(id, verdict, at, review, cycle);
}

describe("cycles", () => {
  it("starts at cycle 1 and advances one per day", () => {
    const db = openDb(":memory:");
    expect(currentCycle(db, T0)).toBe(1);
    expect(currentCycle(db, T0 + DAY)).toBe(2);
    expect(currentCycle(db, T0 + 46 * DAY)).toBe(47);
    // The epoch is pinned on first use, so later calls do not re-anchor it.
    expect(currentCycle(db, T0)).toBe(1);
  });

  it("dates a past ruling into the cycle it was issued in", () => {
    const db = openDb(":memory:");
    currentCycle(db, T0);
    expect(cycleOf(db, T0 + 3 * DAY, T0 + 9 * DAY)).toBe(4);
  });

  it("counts only issued approvals against the cycle's single slot", () => {
    const db = openDb(":memory:");
    const limit = 1;
    expect(cycleSlotFree(db, 1, limit)).toBe(true);

    // Held for countersign: the ruling stands but no money moved, so the
    // slot stays open rather than being blocked by a pending decision.
    seedRuling(db, "D-1", "approved", 1, "pending_review");
    expect(issuedApprovalsInCycle(db, 1)).toBe(0);
    expect(cycleSlotFree(db, 1, limit)).toBe(true);

    seedRuling(db, "D-2", "approved", 1, "auto");
    expect(issuedApprovalsInCycle(db, 1)).toBe(1);
    expect(cycleSlotFree(db, 1, limit)).toBe(false);

    // Rejections never consume the slot, and the next cycle is untouched.
    seedRuling(db, "D-3", "rejected", 1, "auto");
    expect(issuedApprovalsInCycle(db, 1)).toBe(1);
    expect(cycleSlotFree(db, 2, limit)).toBe(true);
  });

  it("counts a countersigned approval once confirmed", () => {
    const db = openDb(":memory:");
    seedRuling(db, "D-1", "approved", 1, "pending_review");
    expect(cycleSlotFree(db, 1, 1)).toBe(true);
    db.prepare("UPDATE rulings SET review_status = 'confirmed' WHERE docket_id = 'D-1'").run();
    expect(cycleSlotFree(db, 1, 1)).toBe(false);
  });

  it("reports days since the last issued approval", () => {
    const db = openDb(":memory:");
    expect(daysSinceLastApproval(db, T0)).toBeNull();
    seedRuling(db, "D-1", "approved", 1, "auto", T0);
    expect(daysSinceLastApproval(db, T0 + 23 * DAY)).toBe(23);
    // A held approval is not an approval yet, so the counter keeps running.
    seedRuling(db, "D-2", "approved", 24, "pending_review", T0 + 23 * DAY);
    expect(daysSinceLastApproval(db, T0 + 23 * DAY)).toBe(23);
  });
});
