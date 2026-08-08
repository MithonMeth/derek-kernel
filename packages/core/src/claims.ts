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
  award_usd: number;
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
 * one place dollars become tokens for a payout.
 */
export async function createClaim(
  db: DB,
  docketId: string,
  awardUsd: number,
  priceUsd: number,
  decimals: number,
  expiryDays: number,
  now: number = Date.now()
): Promise<ClaimRow> {
  const wholeTokens = Math.round(awardUsd / priceUsd);
  if (!Number.isFinite(wholeTokens) || wholeTokens < 1) {
    throw new Error(`award of $${awardUsd} converts to no tokens at price ${priceUsd}`);
  }
  const awardBase = wholeTokensToBase(BigInt(wholeTokens), decimals);
  const code = randomBytes(16).toString("hex"); // 32 hex chars, single use
  await db.run(
    `INSERT INTO claims (code, verdict_id, award_usd, award_tokens, expires_at, status)
     VALUES ($1, $2, $3, $4, $5, 'open')`,
    [code, docketId, awardUsd, awardBase.toString(), now + expiryDays * 86_400_000]
  );
  return (await getClaim(db, code))!;
}

export async function getClaim(db: DB, code: string): Promise<ClaimRow | null> {
  return db.row<ClaimRow>("SELECT * FROM claims WHERE code = $1", [code]);
}

/**
 * Wrong code, reused code, and expired code fail distinctly — the /claim
 * endpoint's contract. The payout itself is executed by the multisig
 * humans; this records where the money should go.
 */
export async function submitClaim(
  db: DB,
  code: string,
  payoutAddress: string,
  now: number = Date.now()
): Promise<ClaimRow> {
  if (!/^[0-9a-f]{32}$/.test(code)) throw new UnknownClaimError("malformed claim code");
  if (!isPlausibleSolanaAddress(payoutAddress)) {
    throw new InvalidAddressError("payout address is not a valid Solana address");
  }

  const claim = await getClaim(db, code);
  if (!claim) throw new UnknownClaimError("no such claim code");
  if (claim.status === "claimed" || claim.status === "paid") {
    throw new AlreadyClaimedError("claim code already used");
  }
  if (claim.status === "expired" || now > Number(claim.expires_at)) {
    if (claim.status === "open") await expireClaims(db, now);
    throw new ExpiredClaimError("claim code expired; funds returned to treasury");
  }

  const changed = await db.run(
    "UPDATE claims SET status = 'claimed', claimed_at = $1, payout_address = $2 WHERE code = $3 AND status = 'open'",
    [now, payoutAddress, code]
  );
  if (changed !== 1) throw new AlreadyClaimedError("claim code already used");
  return (await getClaim(db, code))!;
}

/** Unclaimed after the window → expired; the ledger shows it. Expiries are good content. */
export async function expireClaims(db: DB, now: number = Date.now()): Promise<number> {
  return db.run("UPDATE claims SET status = 'expired' WHERE status = 'open' AND expires_at < $1", [
    now
  ]);
}

/** Admin path, after the multisig actually sends the tokens. */
export async function markClaimPaid(db: DB, code: string, tx: string): Promise<void> {
  const changed = await db.run(
    "UPDATE claims SET status = 'paid', payout_tx = $1 WHERE code = $2 AND status = 'claimed'",
    [tx, code]
  );
  if (changed !== 1) throw new Error("claim is not in 'claimed' state");
}
