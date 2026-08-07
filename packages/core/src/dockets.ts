import type { DB } from "./db.js";
import { allocateDerivationIndex, freeDerivationIndex, nextDocketNumber } from "./db.js";
import type { AddressDeriver } from "./deposits.js";
import type { ChainClient } from "./chain.js";
import type { FeeQuote } from "./oracle.js";
import type { Logger } from "./logger.js";

export const DOCKET_EXPIRY_MS = 60 * 60_000;

export interface DocketRow {
  id: string;
  proposal_id: string;
  deposit_address: string;
  derivation_index: number;
  fee_tokens: string;
  fee_usd_target: number;
  price_usd_at_quote: number;
  quoted_at: number;
  paid_at: number | null;
  paid_tx: string | null;
  swept_at: number | null;
  judge_attempts: number;
  status: string;
}

export function createDocket(
  db: DB,
  deriver: AddressDeriver,
  quote: FeeQuote,
  proposalId: string,
  now: number = Date.now()
): DocketRow {
  const id = `D-${nextDocketNumber(db)}`;
  const index = allocateDerivationIndex(db);
  const address = deriver.deriveAddress(index);
  db.prepare(
    `INSERT INTO dockets (id, proposal_id, deposit_address, derivation_index, fee_tokens,
       fee_usd_target, price_usd_at_quote, quoted_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'awaiting_payment')`
  ).run(id, proposalId, address, index, quote.feeBase.toString(), quote.feeUsdTarget, quote.priceUsd, now);
  return getDocket(db, id)!;
}

export function getDocket(db: DB, id: string): DocketRow | null {
  return (db.prepare("SELECT * FROM dockets WHERE id = ?").get(id) as DocketRow | undefined) ?? null;
}

/** Expire unpaid dockets past the window, freeing their derivation index. */
export function expireDockets(db: DB, now: number = Date.now()): number {
  const stale = db
    .prepare("SELECT id, derivation_index FROM dockets WHERE status = 'awaiting_payment' AND quoted_at < ?")
    .all(now - DOCKET_EXPIRY_MS) as Array<{ id: string; derivation_index: number }>;
  for (const d of stale) {
    db.prepare("UPDATE dockets SET status = 'expired' WHERE id = ? AND status = 'awaiting_payment'").run(d.id);
    freeDerivationIndex(db, d.derivation_index);
  }
  return stale.length;
}

/**
 * One poll pass: expire stale unpaid dockets (freeing their derivation
 * index) and mark paid the ones whose deposit address now holds the fee.
 * Acceptance is >= 80% of the quoted amount — the guide's tolerance for a
 * price that moved while somebody was copying an address.
 */
export async function watchPayments(
  db: DB,
  chain: ChainClient,
  mint: string,
  now: number = Date.now(),
  log?: Logger
): Promise<void> {
  expireDockets(db, now);
  const open = db
    .prepare("SELECT * FROM dockets WHERE status = 'awaiting_payment'")
    .all() as DocketRow[];

  for (const docket of open) {
    let balance: bigint;
    try {
      balance = await chain.getTokenBalanceBase(docket.deposit_address, mint);
    } catch (e) {
      log?.warn({ docket: docket.id, err: (e as Error).message }, "balance check failed");
      continue;
    }

    const fee = BigInt(docket.fee_tokens);
    if (balance * 10n >= fee * 8n && balance > 0n) {
      if (balance < fee) {
        log?.warn({ docket: docket.id }, "underpayment within tolerance accepted");
      }
      const tx = await chain.getLatestSignature(docket.deposit_address).catch(() => null);
      db.prepare(
        "UPDATE dockets SET status = 'paid', paid_at = ?, paid_tx = ? WHERE id = ? AND status = 'awaiting_payment'"
      ).run(now, tx, docket.id);
    }
  }
}
