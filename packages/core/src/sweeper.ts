import type { DB } from "./db.js";
import type { ChainClient } from "./chain.js";
import type { Logger } from "./logger.js";
import type { Limits } from "./constitution.js";

/**
 * Fees arrive in one throwaway deposit address per docket and would otherwise
 * stay there. Sweeping empties them into the three destinations the site
 * promises: burned, Treasury, ops.
 *
 * This is the only code in the project that moves money, so the rules are:
 * move what is actually there rather than what was quoted, never split a
 * balance into more or less than it started as, and never sweep the same
 * balance twice.
 */

export interface FeeSplit {
  burn: number;
  treasury: number;
  ops: number;
}

export interface SweepPlan {
  docketId: string;
  derivationIndex: number;
  address: string;
  /** Base units actually held right now, not the quoted fee. */
  total: bigint;
  burn: bigint;
  treasury: bigint;
  ops: bigint;
}

export interface SweepResult {
  docketId: string;
  signature: string;
}

/** Executes one plan atomically and returns the transaction signature. */
export interface SweepExecutor {
  execute(plan: SweepPlan, signingSeed: Buffer): Promise<string>;
}

export class SweepConfigError extends Error {}

/**
 * Splits a balance exactly. Percentages are applied with integer maths and
 * the Treasury absorbs the remainder, so burn + treasury + ops is always
 * precisely the amount that was there — never a token more or less.
 */
export function splitFee(total: bigint, split: FeeSplit): Omit<SweepPlan, "docketId" | "derivationIndex" | "address"> {
  if (total < 0n) throw new SweepConfigError("cannot split a negative balance");
  const pct = (f: number): bigint => {
    const scaled = Math.round(f * 10_000);
    if (scaled < 0 || scaled > 10_000) throw new SweepConfigError(`bad split fraction ${f}`);
    return BigInt(scaled);
  };
  const burn = (total * pct(split.burn)) / 10_000n;
  const ops = (total * pct(split.ops)) / 10_000n;
  const treasury = total - burn - ops; // remainder lands here by construction
  if (treasury < 0n) throw new SweepConfigError("fee split exceeds 100%");
  return { total, burn, treasury, ops };
}

/**
 * Dockets whose fee has landed and has not yet been moved. Reads the live
 * balance rather than the quoted fee: an underpayment inside tolerance, or an
 * overpayment, both sweep for what is really there.
 */
export async function planSweeps(
  db: DB,
  chain: ChainClient,
  mint: string,
  limits: Limits,
  dustBase: bigint,
  log?: Logger
): Promise<SweepPlan[]> {
  const rows = await db.rows<{
    id: string;
    derivation_index: number;
    deposit_address: string;
  }>(
    `SELECT id, derivation_index, deposit_address FROM dockets
     WHERE paid_at IS NOT NULL AND swept_at IS NULL
     ORDER BY paid_at
     LIMIT 25`
  );

  const plans: SweepPlan[] = [];
  for (const row of rows) {
    let total: bigint;
    try {
      total = await chain.getTokenBalanceBase(row.deposit_address, mint);
    } catch (e) {
      log?.warn({ docket: row.id, err: (e as Error).message }, "sweep balance check failed");
      continue;
    }
    // Below dust the network fee is worth more than the move. Leave it and
    // mark it swept so it stops being reconsidered every cycle.
    if (total <= dustBase) {
      await db.run("UPDATE dockets SET swept_at = $1 WHERE id = $2", [Date.now(), row.id]);
      log?.info({ docket: row.id, total: total.toString() }, "nothing worth sweeping");
      continue;
    }
    plans.push({
      docketId: row.id,
      derivationIndex: row.derivation_index,
      address: row.deposit_address,
      ...splitFee(total, limits.fee_split)
    });
  }
  return plans;
}

export interface SweepDeps {
  db: DB;
  chain: ChainClient;
  executor: SweepExecutor;
  deriveSigningSeed(index: number): Buffer;
  mint: string;
  limits: Limits;
  dustBase: bigint;
  log?: Logger;
}

/**
 * One sweep pass. Each docket is its own transaction: on Solana a signature
 * costs a fraction of a cent, and isolating failures to a single docket is
 * worth far more than the saving from batching them.
 *
 * Recording the signature after the send is deliberately the last step. If
 * the process dies in between, the next pass reads a balance of zero and
 * marks it swept without moving anything — re-sweeping is safe because the
 * amount always comes from the live balance.
 */
export async function runSweep(deps: SweepDeps, now: number = Date.now()): Promise<SweepResult[]> {
  const { db, chain, executor, mint, limits, dustBase, log } = deps;
  const plans = await planSweeps(db, chain, mint, limits, dustBase, log);
  const done: SweepResult[] = [];

  for (const plan of plans) {
    let seed: Buffer | null = null;
    try {
      seed = deps.deriveSigningSeed(plan.derivationIndex);
      const signature = await executor.execute(plan, seed);
      await db.run("UPDATE dockets SET swept_at = $1 WHERE id = $2", [now, plan.docketId]);
      done.push({ docketId: plan.docketId, signature });
      log?.info(
        {
          docket: plan.docketId,
          burned: plan.burn.toString(),
          treasury: plan.treasury.toString(),
          ops: plan.ops.toString(),
          signature
        },
        "swept"
      );
    } catch (e) {
      // Left unswept on purpose: the next pass retries, and a partial send
      // cannot double-spend because the balance is re-read each time.
      log?.error({ docket: plan.docketId, err: (e as Error).message }, "sweep failed");
    } finally {
      if (seed) seed.fill(0); // do not leave key material lying in the heap
    }
  }
  return done;
}

/** Prints what a sweep would do without sending anything. */
export function describePlan(plan: SweepPlan, decimals: number): string {
  const whole = (v: bigint): string => (v / 10n ** BigInt(decimals)).toLocaleString("en-GB");
  return (
    `${plan.docketId}  ${plan.address}\n` +
    `    total ${whole(plan.total)}  ->  burn ${whole(plan.burn)}` +
    `  treasury ${whole(plan.treasury)}  ops ${whole(plan.ops)}`
  );
}
