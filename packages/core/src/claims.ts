import { randomBytes } from "node:crypto";
import type { DB } from "./db.js";
import { isPlausibleSolanaAddress } from "./base58.js";
import { wholeTokensToBase } from "./amounts.js";

export class UnknownClaimError extends Error {}
export class AlreadyClaimedError extends Error {}
export class ExpiredClaimError extends Error {}
export class InvalidAddressError extends Error {}

export interface ClaimRow {
  code: string;
  verdict_id: string;
  award_gbp: number;
  award_tokens: string;
  expires_at: number;
  claimed_at: number | null;
  payout_address: string | null;
  payout_tx: string | null;
  status: string;
}

/**
 * The token amount is locked at ruling time — computing it at claim time
 * would let a price move between ruling and claim be farmed. This is the
 * one place GBP becomes tokens for a payout.
 */
export function createClaim(
  db: DB,
  docketId: string,
  awardGbp: number,
  priceUsd: number,
  usdPerGbp: number,
  decimals: number,
  expiryDays: number,
  now: number = Date.now()
): ClaimRow {
  const wholeTokens = Math.round((awardGbp * usdPerGbp) / priceUsd);
  if (!Number.isFinite(wholeTokens) || wholeTokens < 1) {
    throw new Error(`award of £${awardGbp} converts to no tokens at price ${priceUsd}`);
  }
  const awardBase = wholeTokensToBase(BigInt(wholeTokens), decimals);
  const code = randomBytes(16).toString("hex"); // 32 hex chars, single use
  db.prepare(
    `INSERT INTO claims (code, verdict_id, award_gbp, award_tokens, expires_at, status)
     VALUES (?, ?, ?, ?, ?, 'open')`
  ).run(code, docketId, awardGbp, awardBase.toString(), now + expiryDays * 86_400_000);
  return getClaim(db, code)!;
}

export function getClaim(db: DB, code: string): ClaimRow | null {
  return (db.prepare("SELECT * FROM claims WHERE code = ?").get(code) as ClaimRow | undefined) ?? null;
}

/**
 * Wrong code, reused code, and expired code fail distinctly — the /claim
 * endpoint's contract. The payout itself is executed by the multisig
 * humans; this records where the money should go.
 */
export function submitClaim(db: DB, code: string, payoutAddress: string, now: number = Date.now()): ClaimRow {
  if (!/^[0-9a-f]{32}$/.test(code)) throw new UnknownClaimError("malformed claim code");
  if (!isPlausibleSolanaAddress(payoutAddress)) {
    throw new InvalidAddressError("payout address is not a valid Solana address");
  }

  const claim = getClaim(db, code);
  if (!claim) throw new UnknownClaimError("no such claim code");
  if (claim.status === "claimed" || claim.status === "paid") {
    throw new AlreadyClaimedError("claim code already used");
  }
  if (claim.status === "expired" || now > claim.expires_at) {
    if (claim.status === "open") expireClaims(db, now);
    throw new ExpiredClaimError("claim code expired; funds returned to treasury");
  }

  const changed = db
    .prepare(
      "UPDATE claims SET status = 'claimed', claimed_at = ?, payout_address = ? WHERE code = ? AND status = 'open'"
    )
    .run(now, payoutAddress, code).changes;
  if (changed !== 1) throw new AlreadyClaimedError("claim code already used");
  return getClaim(db, code)!;
}

/** Unclaimed after the window → expired; the ledger shows it. Expiries are good content. */
export function expireClaims(db: DB, now: number = Date.now()): number {
  return db
    .prepare("UPDATE claims SET status = 'expired' WHERE status = 'open' AND expires_at < ?")
    .run(now).changes;
}

/** Admin path, after the multisig actually sends the tokens. */
export function markClaimPaid(db: DB, code: string, tx: string): void {
  const changed = db
    .prepare("UPDATE claims SET status = 'paid', payout_tx = ? WHERE code = ? AND status = 'claimed'")
    .run(tx, code).changes;
  if (changed !== 1) throw new Error("claim is not in 'claimed' state");
}
