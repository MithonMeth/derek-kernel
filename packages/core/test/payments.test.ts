import { describe, expect, it } from "vitest";
import { openDb, type DB } from "../src/db.js";
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

function seedProposal(db: DB, id = "p1"): string {
  db.prepare(
    "INSERT INTO proposals (id, title, amount_gbp, body, created_at) VALUES (?, ?, 34, 'kettle', ?)"
  ).run(id, "Replacement kettle", T0);
  return id;
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
    const db = openDb(":memory:");
    const docket = createDocket(db, new HdAddressDeriver(SEED), QUOTE, seedProposal(db), T0);
    const chain = new FakeChainClient();

    await watchPayments(db, chain, MINT, T0 + 30_000);
    expect(
      (db.prepare("SELECT status FROM dockets WHERE id = ?").get(docket.id) as { status: string })
        .status
    ).toBe("awaiting_payment");

    chain.setBalance(docket.deposit_address, QUOTE.feeBase); // the transfer lands
    await watchPayments(db, chain, MINT, T0 + 60_000);
    const row = db.prepare("SELECT status, paid_tx FROM dockets WHERE id = ?").get(docket.id) as {
      status: string;
      paid_tx: string | null;
    };
    expect(row.status).toBe("paid");
    expect(row.paid_tx).toBeTruthy();
  });

  it("accepts a late payment within the 20% tolerance, rejects below it", async () => {
    const db = openDb(":memory:");
    seedProposal(db, "p1");
    seedProposal(db, "p2");
    const deriver = new HdAddressDeriver(SEED);
    const dOk = createDocket(db, deriver, QUOTE, "p1", T0);
    const dLow = createDocket(db, deriver, QUOTE, "p2", T0);
    const chain = new FakeChainClient();
    chain.setBalance(dOk.deposit_address, (QUOTE.feeBase * 85n) / 100n); // -15%: accepted
    chain.setBalance(dLow.deposit_address, (QUOTE.feeBase * 70n) / 100n); // -30%: not enough

    await watchPayments(db, chain, MINT, T0 + 60_000);
    const status = (id: string) =>
      (db.prepare("SELECT status FROM dockets WHERE id = ?").get(id) as { status: string }).status;
    expect(status(dOk.id)).toBe("paid");
    expect(status(dLow.id)).toBe("awaiting_payment");
  });

  it("expires unpaid dockets after 60 minutes and frees the index", async () => {
    const db = openDb(":memory:");
    const docket = createDocket(db, new HdAddressDeriver(SEED), QUOTE, seedProposal(db), T0);
    await watchPayments(db, new FakeChainClient(), MINT, T0 + DOCKET_EXPIRY_MS + 1);
    expect(
      (db.prepare("SELECT status FROM dockets WHERE id = ?").get(docket.id) as { status: string })
        .status
    ).toBe("expired");
    // The freed index is reused by the next docket.
    seedProposal(db, "p2");
    const next = createDocket(db, new HdAddressDeriver(SEED), QUOTE, "p2", T0);
    expect(next.derivation_index).toBe(docket.derivation_index);
  });
});

function seedRuling(db: DB, docketId: string): void {
  db.prepare(
    `INSERT INTO rulings (docket_id, verdict, award_gbp, ruling_line, ruling_text, model, ruled_at, review_status)
     VALUES (?, 'rejected', NULL, 'There are nine adjectives and no object.', 'Rejected.', 'test', ?, 'auto')`
  ).run(docketId, T0);
}

describe("claims", () => {
  function setup(): { db: DB; code: string } {
    const db = openDb(":memory:");
    const docket = createDocket(db, new HdAddressDeriver(SEED), QUOTE, seedProposal(db), T0);
    seedRuling(db, docket.id);
    const claim = createClaim(db, docket.id, 310, 0.00004, 1.28, 9, 7, T0);
    return { db, code: claim.code };
  }
  const GOOD_ADDR = new HdAddressDeriver(SEED).deriveAddress(99);

  it("locks the token amount at ruling-time price", () => {
    const { db, code } = setup();
    const claim = getClaim(db, code)!;
    // £310 × 1.28 USD/GBP ÷ $0.00004 = 9,920,000 whole tokens.
    expect(BigInt(claim.award_tokens)).toBe(9_920_000n * 10n ** 9n);
    expect(claim.code).toMatch(/^[0-9a-f]{32}$/);
  });

  it("wrong, reused, and expired codes fail distinctly", () => {
    const { db, code } = setup();
    expect(() => submitClaim(db, "0".repeat(32), GOOD_ADDR, T0)).toThrow(UnknownClaimError);
    expect(() => submitClaim(db, "not-a-code", GOOD_ADDR, T0)).toThrow(UnknownClaimError);

    submitClaim(db, code, GOOD_ADDR, T0 + 1000);
    expect(() => submitClaim(db, code, GOOD_ADDR, T0 + 2000)).toThrow(AlreadyClaimedError);

    const fresh = setup();
    expect(() =>
      submitClaim(fresh.db, fresh.code, GOOD_ADDR, T0 + 8 * 86_400_000)
    ).toThrow(ExpiredClaimError);
  });

  it("rejects a malformed address before anything is recorded", () => {
    const { db, code } = setup();
    expect(() => submitClaim(db, code, "definitely-not-base58!!", T0)).toThrow(InvalidAddressError);
    expect(getClaim(db, code)!.status).toBe("open");
  });

  it("expiry sweep returns unclaimed codes to the treasury", () => {
    const { db, code } = setup();
    expect(expireClaims(db, T0 + 8 * 86_400_000)).toBe(1);
    expect(getClaim(db, code)!.status).toBe("expired");
  });
});

describe("publisher", () => {
  const OPTS = { siteUrl: "https://derek.example", tokenDecimals: 9, burnFraction: 0.5 };

  function setup(): { db: DB; docketId: string } {
    const db = openDb(":memory:");
    const docket = createDocket(db, new HdAddressDeriver(SEED), QUOTE, seedProposal(db), T0);
    seedRuling(db, docket.id);
    return { db, docketId: docket.id };
  }

  it("templates from structured fields and keeps only the site link", () => {
    const { db, docketId } = setup();
    db.prepare("UPDATE rulings SET ruling_line = ? WHERE docket_id = ?").run(
      "See https://evil.example and @scammer for details",
      docketId
    );
    const row = db
      .prepare(
        `SELECT r.docket_id, r.verdict, r.ruling_line, d.fee_tokens, p.amount_gbp, r.award_gbp
         FROM rulings r JOIN dockets d ON d.id = r.docket_id JOIN proposals p ON p.id = d.proposal_id
         WHERE r.docket_id = ?`
      )
      .get(docketId) as never;
    const text = buildPostText(row, OPTS);
    expect(text).toContain(`${OPTS.siteUrl}/r/${docketId}`);
    expect(text).not.toContain("evil.example");
    expect(text).not.toContain("@scammer");
    expect(text).toContain("5,000 $DEREK burned");
  });

  it("a simulated API failure mid-post does not produce a duplicate on retry", async () => {
    const { db, docketId } = setup();
    // Transport accepts the post server-side, then the connection "drops".
    const posts: string[] = [];
    const transport: PostTransport = {
      async post(text, key) {
        posts.push(key);
        if (posts.length === 1) throw new Error("socket hang up after server accepted");
        return { id: `post-${posts.length}` };
      },
      async find(key) {
        return posts.includes(key) ? { id: "post-1" } : null;
      }
    };

    await publishRuling(db, transport, docketId, OPTS);
    const first = db.prepare("SELECT post_status, post_id FROM rulings WHERE docket_id = ?").get(docketId) as {
      post_status: string;
      post_id: string | null;
    };
    // Reconciliation found the accepted post; no retry will re-send it.
    expect(first.post_status).toBe("posted");

    await publishRuling(db, transport, docketId, OPTS);
    expect(posts).toHaveLength(1); // exactly one network post, ever
  });

  it("queues manually when no transport is configured", async () => {
    const { db, docketId } = setup();
    await publishRuling(db, null, docketId, OPTS);
    expect(
      (db.prepare("SELECT post_status FROM rulings WHERE docket_id = ?").get(docketId) as {
        post_status: string;
      }).post_status
    ).toBe("queued_manual");
  });
});
