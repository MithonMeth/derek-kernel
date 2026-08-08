import { randomBytes } from "node:crypto";
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
  view_token: string | null;
}

export async function createDocket(
  db: DB,
  deriver: AddressDeriver,
  quote: FeeQuote,
  proposalId: string,
  now: number = Date.now()
): Promise<DocketRow> {
  const id = `D-${await nextDocketNumber(db)}`;
  const viewToken = randomBytes(16).toString("hex");
  const index = await allocateDerivationIndex(db);
  const address = deriver.deriveAddress(index);
  await db.run(
    `INSERT INTO dockets (id, proposal_id, deposit_address, derivation_index, fee_tokens,
       fee_usd_target, price_usd_at_quote, quoted_at, status, view_token)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'awaiting_payment', $9)`,
    [
      id,
      proposalId,
      address,
      index,
      quote.feeBase.toString(),
      quote.feeUsdTarget,
      quote.priceUsd,
      now,
      viewToken
    ]
  );
  return (await getDocket(db, id))!;
}

export async function getDocket(db: DB, id: string): Promise<DocketRow | null> {
  return db.row<DocketRow>("SELECT * FROM dockets WHERE id = $1", [id]);
}

/** Expire unpaid dockets past the window, freeing their derivation index. */
export async function expireDockets(db: DB, now: number = Date.now()): Promise<number> {
  const stale = await db.rows<{ id: string; derivation_index: number }>(
    `UPDATE dockets SET status = 'expired'
     WHERE status = 'awaiting_payment' AND quoted_at < $1
     RETURNING id, derivation_index`,
    [now - DOCKET_EXPIRY_MS]
  );
  for (const d of stale) await freeDerivationIndex(db, d.derivation_index);
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
  await expireDockets(db, now);
  const open = await db.rows<DocketRow>("SELECT * FROM dockets WHERE status = 'awaiting_payment'");

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
      await db.run(
        "UPDATE dockets SET status = 'paid', paid_at = $1, paid_tx = $2 WHERE id = $3 AND status = 'awaiting_payment'",
        [now, tx, docket.id]
      );
    }
  }
}
