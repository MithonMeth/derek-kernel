import type { DB } from "./db.js";
import { sanitizePublishedText } from "./guards.js";
import { formatWholeTokens, parseBase } from "./amounts.js";
import { recordXPost } from "./spend.js";
import { renderRulingCard } from "./cards.js";
import type { Logger } from "./logger.js";

/**
 * The publisher is the last gate before text reaches X. It templates from
 * structured verdict fields only — never raw model prose — and strips
 * URLs/mentions/addresses again even though the guard already did.
 */
export interface PostTransport {
  /** Post `text`; `key` is an idempotency key (the docket id). */
  post(text: string, key: string, mediaIds?: string[]): Promise<{ id: string }>;
  /** Look up a previous post by idempotency key, for reconciliation. */
  find(key: string): Promise<{ id: string } | null>;
  /** Upload a PNG, returning its media id. Absent on transports without media. */
  uploadMedia?(png: Buffer): Promise<string>;
}

interface PublishableRuling {
  docket_id: string;
  verdict: string;
  ruling_line: string;
  fee_tokens: string;
  amount_usd: number;
  award_usd: number | null;
}

/**
 * Renders and uploads the ruling card. The post carries no URL, so this
 * image is the only route back to the site — but a media failure must not
 * cost the ruling its post, so this degrades to a text-only post rather
 * than throwing.
 */
async function attachCard(
  transport: PostTransport,
  row: PublishableRuling,
  opts: { siteUrl: string; tokenDecimals: number; burnFraction: number },
  log?: Logger
): Promise<string[] | undefined> {
  if (!transport.uploadMedia) return undefined;
  try {
    const feeBase = parseBase(row.fee_tokens);
    const burnedBase = (feeBase * BigInt(Math.round(opts.burnFraction * 100))) / 100n;
    const png = renderRulingCard({
      docketId: row.docket_id,
      verdict: row.verdict,
      rulingLine: row.ruling_line,
      amountUsd: row.amount_usd,
      awardUsd: row.award_usd,
      burnedTokens: formatWholeTokens(burnedBase, opts.tokenDecimals),
      siteHost: opts.siteUrl.replace(/^https?:\/\//, "").replace(/\/$/, "")
    });
    return [await transport.uploadMedia(png)];
  } catch (e) {
    log?.warn({ docket: row.docket_id, err: (e as Error).message }, "card failed; posting without it");
    return undefined;
  }
}

export function buildPostText(
  r: PublishableRuling,
  opts: { siteUrl: string; tokenDecimals: number; burnFraction: number }
): string {
  const line = sanitizePublishedText(r.ruling_line, 180);
  const feeBase = parseBase(r.fee_tokens);
  const burnedBase = (feeBase * BigInt(Math.round(opts.burnFraction * 100))) / 100n;
  const burned = formatWholeTokens(burnedBase, opts.tokenDecimals);
  const money = (n: number): string => `$${n.toLocaleString("en-US")}`;
  const verdictLine =
    r.verdict === "approved" ? `APPROVED · ${money(r.award_usd ?? 0)}` : r.verdict.toUpperCase();
  // Deliberately no URL. Since Feb 2026 X charges $0.015 to post and $0.20
  // if the text contains a link - more than the airdrop share of a whole
  // fee. The permalink lives on the share card image instead,
  // where it costs nothing. Do not add one back without redoing that sum.
  return sanitizePublishedText(
    [
      `Docket ${r.docket_id} — ${verdictLine}`,
      "",
      `“${line}”`,
      "",
      `Requested ${money(r.amount_usd)} · ${burned} $DEREK burned either way`
    ].join("\n"),
    560
  );
}

/**
 * Never double-posts: the row is claimed transactionally before the network
 * call, and a failed call reconciles against the transport by idempotency
 * key before the row is ever released for retry.
 */
export async function publishRuling(
  db: DB,
  transport: PostTransport | null,
  docketId: string,
  opts: { siteUrl: string; tokenDecimals: number; burnFraction: number },
  log?: Logger
): Promise<void> {
  const row = await db.row<PublishableRuling>(
    `SELECT r.docket_id, r.verdict, r.ruling_line, d.fee_tokens, p.amount_usd, r.award_usd
     FROM rulings r
     JOIN dockets d ON d.id = r.docket_id
     JOIN proposals p ON p.id = d.proposal_id
     WHERE r.docket_id = $1`,
    [docketId]
  );
  if (!row) return;

  // Atomic claim: only one caller ever moves unposted -> posting.
  const claimed = await db.run(
    "UPDATE rulings SET post_status = 'posting' WHERE docket_id = $1 AND post_status = 'unposted'",
    [docketId]
  );
  if (claimed !== 1) return;

  if (!transport) {
    // No X credentials configured: manual queue, posted by hand.
    await db.run("UPDATE rulings SET post_status = 'queued_manual' WHERE docket_id = $1", [docketId]);
    return;
  }

  const text = buildPostText(row, opts);
  const mediaIds = await attachCard(transport, row, opts, log);
  try {
    const posted = await transport.post(text, docketId, mediaIds);
    await recordXPost(db);
    await db.run("UPDATE rulings SET post_status = 'posted', post_id = $1 WHERE docket_id = $2", [
      posted.id,
      docketId
    ]);
  } catch (e) {
    log?.warn({ docket: docketId, err: (e as Error).message }, "post failed; reconciling");
    // The call may have succeeded server-side before the failure. Ask.
    const existing = await transport.find(docketId).catch(() => null);
    if (existing) {
      await recordXPost(db); // it landed after all, so it was billed
      await db.run("UPDATE rulings SET post_status = 'posted', post_id = $1 WHERE docket_id = $2", [
        existing.id,
        docketId
      ]);
    } else {
      // Genuinely not posted — release for a later retry.
      await db.run("UPDATE rulings SET post_status = 'unposted' WHERE docket_id = $1", [docketId]);
    }
  }
}
