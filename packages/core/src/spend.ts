import type { DB } from "./db.js";

export interface CallUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/**
 * USD per million tokens. Sonnet 5 is at introductory pricing ($2/$10)
 * through 2026-08-31, reverting to $3/$15 — revisit then. Cache reads bill
 * at 10% of input; cache writes at 1.25x.
 */
const PRICES: Record<string, { input: number; output: number }> = {
  "claude-haiku-4-5": { input: 1, output: 5 },
  "claude-sonnet-5": { input: 2, output: 10 }
};

export function costOfCall(model: string, usage: CallUsage): number {
  const p = PRICES[model];
  if (!p) throw new Error(`no price table entry for model ${model}`);
  const m = 1_000_000;
  return (
    (usage.inputTokens / m) * p.input +
    (usage.outputTokens / m) * p.output +
    ((usage.cacheReadTokens ?? 0) / m) * p.input * 0.1 +
    ((usage.cacheWriteTokens ?? 0) / m) * p.input * 1.25
  );
}

function today(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export async function recordSpend(db: DB, costUsd: number, now: number = Date.now()): Promise<void> {
  await db.run(
    `INSERT INTO spend_log (day, api_cost_usd, calls) VALUES ($1, $2, 1)
     ON CONFLICT (day) DO UPDATE SET
       api_cost_usd = spend_log.api_cost_usd + excluded.api_cost_usd,
       calls = spend_log.calls + 1`,
    [today(now), costUsd]
  );
}

export async function todaySpendUsd(db: DB, now: number = Date.now()): Promise<number> {
  const row = await db.row<{ api_cost_usd: number }>(
    "SELECT api_cost_usd FROM spend_log WHERE day = $1",
    [today(now)]
  );
  return row?.api_cost_usd ?? 0;
}

/**
 * X pay-per-use, as of February 2026. The link price is recorded because it
 * is the reason the publisher posts no URL — see buildPostText.
 */
export const X_POST_COST_USD = 0.015;
export const X_POST_WITH_LINK_COST_USD = 0.2;

export async function recordXPost(db: DB, now: number = Date.now()): Promise<void> {
  await db.run(
    `INSERT INTO spend_log (day, api_cost_usd, calls, x_cost_usd, x_posts)
     VALUES ($1, 0, 0, $2, 1)
     ON CONFLICT (day) DO UPDATE SET
       x_cost_usd = spend_log.x_cost_usd + excluded.x_cost_usd,
       x_posts = spend_log.x_posts + 1`,
    [today(now), X_POST_COST_USD]
  );
}

export async function todayXSpendUsd(db: DB, now: number = Date.now()): Promise<number> {
  const row = await db.row<{ x_cost_usd: number }>(
    "SELECT x_cost_usd FROM spend_log WHERE day = $1",
    [today(now)]
  );
  return row?.x_cost_usd ?? 0;
}

/** A runaway publish loop would otherwise burn credits unattended. */
export async function underXDailyCap(
  db: DB,
  maxDailyUsd: number,
  now: number = Date.now()
): Promise<boolean> {
  return (await todayXSpendUsd(db, now)) + X_POST_COST_USD <= maxDailyUsd;
}

/** You cannot cap what you don't measure — the worker checks this every cycle. */
export async function underDailyCap(
  db: DB,
  maxDailyUsd: number,
  now: number = Date.now()
): Promise<boolean> {
  return (await todaySpendUsd(db, now)) < maxDailyUsd;
}
