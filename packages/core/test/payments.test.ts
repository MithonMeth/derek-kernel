import { afterAll, describe, expect, it } from "vitest";
import type { DB } from "../src/db.js";
import { HdAddressDeriver } from "../src/deposits.js";
import { FakeChainClient } from "../src/chain.js";
import { createDocket, watchPayments, DOCKET_EXPIRY_MS } from "../src/dockets.js";
import { isPlausibleSolanaAddress, base58Decode } from "../src/base58.js";
import {
  AlreadyClaimedError,
  ExpiredClaimError,
  InvalidAddressError,
  UnknownClaimError,
  createClaim,
  expireClaims,
  getClaim,
  submitClaim
} from "../src/claims.js";
import { buildPostText, publishRuling, type PostTransport } from "../src/publisher.js";
import { closeTestDbs, testDb } from "./helpers.js";

afterAll(closeTestDbs);

const SEED = "ab".repeat(32);
const MINT = "So11111111111111111111111111111111111111112";
const T0 = 1_800_000_000_000;
const QUOTE = {
  feeBase: 10_000n * 10n ** 9n,
  feeUsdTarget: 0.4,
  priceUsd: 0.00004,
  quotedAt: T0,
  frozen: false
};

async function seedProposal(db: DB, id = "p1"): Promise<string> {
  await db.run(
    "INSERT INTO proposals (id, title, amount_gbp, body, created_at) VALUES ($1, $2, 34, 'kettle', $3)",
    [id, "Replacement kettle", T0]
  );
  return id;
}

async function statusOf(db: DB, id: string): Promise<string> {
  const row = await db.row<{ status: string }>("SELECT status FROM dockets WHERE id = $1", [id]);
  return row!.status;
}

describe("deposit addresses", () => {
  it("derives deterministic, distinct, valid Solana addresses", () => {
    const d1 = new HdAddressDeriver(SEED);
    const d2 = new HdAddressDeriver(SEED);
    const a0 = d1.deriveAddress(0);
    const a1 = d1.deriveAddress(1);
    expect(a0).not.toBe(a1);
    expect(d2.deriveAddress(0)).toBe(a0); // same seed, same address
    expect(isPlausibleSolanaAddress(a0)).toBe(true);
    expect(base58Decode(a0)).toHaveLength(32);
  });

  it("a different seed produces different addresses", () => {
    expect(new HdAddressDeriver("cd".repeat(32)).deriveAddress(0)).not.toBe(
      new HdAddressDeriver(SEED).deriveAddress(0)
    );
  });
});

describe("payment watching", () => {
  it("flips a docket to paid within one poll after a transfer", async () => {
    const db = await testDb();
    const docket = await createDocket(
      db,
      new HdAddressDeriver(SEED),
      QUOTE,
      await seedProposal(db),
      T0
    );
    const chain = new FakeChainClient();

    await watchPayments(db, chain, MINT, T0 + 30_000);
    expect(await statusOf(db, docket.id)).toBe("awaiting_payment");

    chain.setBalance(docket.deposit_address, QUOTE.feeBase); // the transfer lands
    await watchPayments(db, chain, MINT, T0 + 60_000);
    const row = await db.row<{ status: string; paid_tx: string | null }>(
      "SELECT status, paid_tx FROM dockets WHERE id = $1",
      [docket.id]
    );
    expect(row!.status).toBe("paid");
    expect(row!.paid_tx).toBeTruthy();
  });

  it("accepts a late payment within the 20% tolerance, rejects below it", async () => {
    const db = await testDb();
    await seedProposal(db, "p1");
    await seedProposal(db, "p2");
    const deriver = new HdAddressDeriver(SEED);
    const dOk = await createDocket(db, deriver, QUOTE, "p1", T0);
    const dLow = await createDocket(db, deriver, QUOTE, "p2", T0);
    const chain = new FakeChainClient();
    chain.setBalance(dOk.deposit_address, (QUOTE.feeBase * 85n) / 100n); // -15%: accepted
    chain.setBalance(dLow.deposit_address, (QUOTE.feeBase * 70n) / 100n); // -30%: not enough

    await watchPayments(db, chain, MINT, T0 + 60_000);
    expect(await statusOf(db, dOk.id)).toBe("paid");
    expect(await statusOf(db, dLow.id)).toBe("awaiting_payment");
  });

  it("expires unpaid dockets after 60 minutes and frees the index", async () => {
    const db = await testDb();
    const docket = await createDocket(
      db,
      new HdAddressDeriver(SEED),
      QUOTE,
      await seedProposal(db),
      T0
    );
    await watchPayments(db, new FakeChainClient(), MINT, T0 + DOCKET_EXPIRY_MS + 1);
    expect(await statusOf(db, docket.id)).toBe("expired");
    // The freed index is reused by the next docket.
    await seedProposal(db, "p2");
    const next = await createDocket(db, new HdAddressDeriver(SEED), QUOTE, "p2", T0);
    expect(next.derivation_index).toBe(docket.derivation_index);
  });
});

async function seedRuling(db: DB, docketId: string): Promise<void> {
  await db.run(
    `INSERT INTO rulings (docket_id, verdict, award_gbp, ruling_line, ruling_text, model, ruled_at, review_status)
     VALUES ($1, 'rejected', NULL, 'There are nine adjectives and no object.', 'Rejected.', 'test', $2, 'auto')`,
    [docketId, T0]
  );
}

describe("claims", () => {
  async function setup(): Promise<{ db: DB; code: string }> {
    const db = await testDb();
    const docket = await createDocket(
      db,
      new HdAddressDeriver(SEED),
      QUOTE,
      await seedProposal(db),
      T0
    );
    await seedRuling(db, docket.id);
    const claim = await createClaim(db, docket.id, 310, 0.00004, 1.28, 9, 7, T0);
    return { db, code: claim.code };
  }
  const GOOD_ADDR = new HdAddressDeriver(SEED).deriveAddress(99);

  it("locks the token amount at ruling-time price", async () => {
    const { db, code } = await setup();
    const claim = (await getClaim(db, code))!;
    // £310 × 1.28 USD/GBP ÷ $0.00004 = 9,920,000 whole tokens.
    expect(BigInt(claim.award_tokens)).toBe(9_920_000n * 10n ** 9n);
    expect(claim.code).toMatch(/^[0-9a-f]{32}$/);
  });

  it("wrong, reused, and expired codes fail distinctly", async () => {
    const { db, code } = await setup();
    await expect(submitClaim(db, "0".repeat(32), GOOD_ADDR, T0)).rejects.toThrow(UnknownClaimError);
    await expect(submitClaim(db, "not-a-code", GOOD_ADDR, T0)).rejects.toThrow(UnknownClaimError);

    await submitClaim(db, code, GOOD_ADDR, T0 + 1000);
    await expect(submitClaim(db, code, GOOD_ADDR, T0 + 2000)).rejects.toThrow(AlreadyClaimedError);

    const fresh = await setup();
    await expect(
      submitClaim(fresh.db, fresh.code, GOOD_ADDR, T0 + 8 * 86_400_000)
    ).rejects.toThrow(ExpiredClaimError);
  });

  it("rejects a malformed address before anything is recorded", async () => {
    const { db, code } = await setup();
    await expect(submitClaim(db, code, "definitely-not-base58!!", T0)).rejects.toThrow(
      InvalidAddressError
    );
    expect((await getClaim(db, code))!.status).toBe("open");
  });

  it("expiry sweep returns unclaimed codes to the treasury", async () => {
    const { db, code } = await setup();
    expect(await expireClaims(db, T0 + 8 * 86_400_000)).toBe(1);
    expect((await getClaim(db, code))!.status).toBe("expired");
  });
});

describe("publisher", () => {
  const OPTS = { siteUrl: "https://derek.example", tokenDecimals: 9, burnFraction: 0.5 };

  async function setup(): Promise<{ db: DB; docketId: string }> {
    const db = await testDb();
    const docket = await createDocket(
      db,
      new HdAddressDeriver(SEED),
      QUOTE,
      await seedProposal(db),
      T0
    );
    await seedRuling(db, docket.id);
    return { db, docketId: docket.id };
  }

  it("templates from structured fields and keeps only the site link", async () => {
    const { db, docketId } = await setup();
    await db.run("UPDATE rulings SET ruling_line = $1 WHERE docket_id = $2", [
      "See https://evil.example and @scammer for details",
      docketId
    ]);
    const row = (await db.row(
      `SELECT r.docket_id, r.verdict, r.ruling_line, d.fee_tokens, p.amount_gbp, r.award_gbp
       FROM rulings r JOIN dockets d ON d.id = r.docket_id JOIN proposals p ON p.id = d.proposal_id
       WHERE r.docket_id = $1`,
      [docketId]
    )) as never;
    const text = buildPostText(row, OPTS);
    expect(text).toContain(`${OPTS.siteUrl}/r/${docketId}`);
    expect(text).not.toContain("evil.example");
    expect(text).not.toContain("@scammer");
    expect(text).toContain("5,000 $DEREK burned");
  });

  it("a simulated API failure mid-post does not produce a duplicate on retry", async () => {
    const { db, docketId } = await setup();
    // Transport accepts the post server-side, then the connection "drops".
    const posts: string[] = [];
    const transport: PostTransport = {
      async post(_text, key) {
        posts.push(key);
        if (posts.length === 1) throw new Error("socket hang up after server accepted");
        return { id: `post-${posts.length}` };
      },
      async find(key) {
        return posts.includes(key) ? { id: "post-1" } : null;
      }
    };

    await publishRuling(db, transport, docketId, OPTS);
    const first = await db.row<{ post_status: string; post_id: string | null }>(
      "SELECT post_status, post_id FROM rulings WHERE docket_id = $1",
      [docketId]
    );
    // Reconciliation found the accepted post; no retry will re-send it.
    expect(first!.post_status).toBe("posted");

    await publishRuling(db, transport, docketId, OPTS);
    expect(posts).toHaveLength(1); // exactly one network post, ever
  });

  it("queues manually when no transport is configured", async () => {
    const { db, docketId } = await setup();
    await publishRuling(db, null, docketId, OPTS);
    const row = await db.row<{ post_status: string }>(
      "SELECT post_status FROM rulings WHERE docket_id = $1",
      [docketId]
    );
    expect(row!.post_status).toBe("queued_manual");
  });
});
