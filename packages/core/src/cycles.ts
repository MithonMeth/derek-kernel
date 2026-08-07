import type { DB } from "./db.js";
import { kvGet, kvSet } from "./db.js";

const DAY_MS = 86_400_000;

/**
 * A cycle is a day. The constitution has the Manager reading in the evening
 * and deciding once, and the record counts days since the last approval, so
 * the day is the natural unit — and it is what "Approvals per cycle: 1" is
 * measured against.
 *
 * The epoch is fixed on first boot rather than hardcoded, so cycle numbers
 * are stable for a given deployment and start at 1.
 */
export async function cycleEpoch(db: DB, now: number = Date.now()): Promise<number> {
  const stored = await kvGet(db, "cycle_epoch");
  if (stored !== null) return Number(stored);
  const epoch = Math.floor(now / DAY_MS) * DAY_MS; // start of the UTC day
  await kvSet(db, "cycle_epoch", String(epoch));
  return epoch;
}

export async function currentCycle(db: DB, now: number = Date.now()): Promise<number> {
  return cycleOf(db, now, now);
}

export async function cycleOf(db: DB, at: number, now: number = Date.now()): Promise<number> {
  const epoch = await cycleEpoch(db, now);
  return Math.floor((at - epoch) / DAY_MS) + 1;
}

/**
 * Approvals that have actually issued in a cycle. One still held for
 * countersign has not issued, so it does not consume the cycle's slot —
 * otherwise a single held ruling would silently block the next one too.
 */
export async function issuedApprovalsInCycle(db: DB, cycle: number): Promise<number> {
  const row = await db.row<{ n: string }>(
    `SELECT COUNT(*) AS n FROM rulings
     WHERE verdict = 'approved' AND cycle = $1 AND review_status IN ('auto', 'confirmed')`,
    [cycle]
  );
  return Number(row?.n ?? 0);
}

export async function cycleSlotFree(
  db: DB,
  cycle: number,
  approvalsPerCycle: number
): Promise<boolean> {
  return (await issuedApprovalsInCycle(db, cycle)) < approvalsPerCycle;
}

/** Days since the last issued approval — the counter the record puts in bold. */
export async function daysSinceLastApproval(
  db: DB,
  now: number = Date.now()
): Promise<number | null> {
  const row = await db.row<{ t: number | null }>(
    `SELECT MAX(ruled_at) AS t FROM rulings
     WHERE verdict = 'approved' AND review_status IN ('auto', 'confirmed')`
  );
  if (!row?.t) return null;
  return Math.floor((now - Number(row.t)) / DAY_MS);
}
