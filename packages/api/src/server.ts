import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import compress from "@fastify/compress";
import QRCode from "qrcode";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  AlreadyClaimedError,
  ExpiredClaimError,
  InvalidAddressError,
  QUOTE_TTL_MS,
  Runtime,
  SubmissionsPausedError,
  UnknownClaimError,
  baseToWholeTokens,
  createDocket,
  createLogger,
  formatWholeTokens,
  kvGet,
  loadConfig,
  parseBase,
  submitClaim,
  type DocketRow
} from "@derek/core";

const log = createLogger("derek-api");
const cfg = loadConfig();

const constitutionDir = fileURLToPath(new URL("../../../constitution", import.meta.url));
const webRoot = fileURLToPath(new URL("../../web/public", import.meta.url));

let runtime: Runtime;
try {
  runtime = new Runtime(cfg, constitutionDir, log);
} catch (e) {
  log.fatal({ err: (e as Error).message }, "refusing to start");
  process.exit(1);
}
if (cfg.EMBED_WORKER) runtime.start();

const db = runtime.db;
const app = Fastify({ loggerInstance: log, trustProxy: true });

await app.register(rateLimit, { max: 200, timeWindow: 60_000 });
// three.js and the model are ~1.5MB raw; they compress to roughly a third.
// The .glb is already-compressed PNG texture data, so leave it alone.
await app.register(compress, {
  global: true,
  threshold: 1024,
  encodings: ["br", "gzip"],
  customTypes: /^(text\/|application\/(javascript|json|wasm)|image\/svg)/
});
await app.register(fastifyStatic, {
  root: webRoot,
  setHeaders(res, path) {
    // Fingerprint-free URLs, so keep HTML revalidating but let the heavy
    // immutable assets sit in the browser cache.
    if (/[\\/](vendor|models)[\\/]/.test(path)) {
      res.setHeader("cache-control", "public, max-age=604800");
    }
  }
});

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function displayTokens(base: string): string {
  return formatWholeTokens(parseBase(base), cfg.TOKEN_DECIMALS);
}

const ProposalBody = z.object({
  title: z.string().trim().min(1).max(120),
  amountGbp: z.number().finite().gt(0).lte(1_000_000),
  body: z.string().trim().min(1).max(2000)
});

app.post(
  "/api/proposals",
  { config: { rateLimit: { max: 10, timeWindow: 60_000 } } },
  async (req, reply) => {
    const parsed = ProposalBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid", message: "Name the thing, give a number, write the proposal." });
    }
    if (runtime.isPaused()) {
      return reply.code(503).send({ error: "paused", message: "Intake is paused. Derek is being commissioned." });
    }
    if (!runtime.deriver) {
      return reply.code(503).send({ error: "paused", message: "Deposits are not configured yet." });
    }
    const hourAgo = Date.now() - 3_600_000;
    const recent = (
      db.prepare("SELECT COUNT(*) n FROM dockets WHERE quoted_at > ?").get(hourAgo) as { n: number }
    ).n;
    if (recent >= cfg.MAX_SUBMISSIONS_PER_HOUR) {
      return reply.code(429).send({ error: "backlog", message: "There is a backlog. Derek reads at his own pace." });
    }

    let quote;
    try {
      quote = runtime.quoteFee();
    } catch (e) {
      if (e instanceof SubmissionsPausedError) {
        return reply.code(503).send({ error: "no_price", message: "No defensible price is available. Submissions are paused." });
      }
      throw e;
    }

    const proposalId = randomUUID();
    const p = parsed.data;
    db.prepare(
      "INSERT INTO proposals (id, title, amount_gbp, body, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run(proposalId, p.title, p.amountGbp, p.body, Date.now());
    const docket = createDocket(db, runtime.deriver, quote, proposalId);

    const uiAmount = baseToWholeTokens(quote.feeBase, cfg.TOKEN_DECIMALS).toString();
    const payUri = cfg.TOKEN_MINT_ADDRESS
      ? `solana:${docket.deposit_address}?amount=${uiAmount}&spl-token=${cfg.TOKEN_MINT_ADDRESS}`
      : `solana:${docket.deposit_address}`;
    const qrDataUrl = await QRCode.toDataURL(payUri, { margin: 1, width: 240 });

    return {
      docketId: docket.id,
      depositAddress: docket.deposit_address,
      feeTokens: displayTokens(docket.fee_tokens),
      feeBaseUnits: docket.fee_tokens,
      feeUsdTarget: quote.feeUsdTarget,
      priceUsd: quote.priceUsd,
      quoteExpiresAt: docket.quoted_at + QUOTE_TTL_MS,
      payUri,
      qrDataUrl
    };
  }
);

app.get("/api/dockets/:id", async (req, reply) => {
  const { id } = req.params as { id: string };
  const docket = db.prepare("SELECT * FROM dockets WHERE id = ?").get(id) as DocketRow | undefined;
  if (!docket) return reply.code(404).send({ error: "not_found" });

  const out: Record<string, unknown> = {
    docketId: docket.id,
    status: docket.status,
    depositAddress: docket.deposit_address,
    feeTokens: displayTokens(docket.fee_tokens),
    quoteExpiresAt: docket.quoted_at + QUOTE_TTL_MS,
    paidAt: docket.paid_at
  };

  const ruling = db.prepare("SELECT * FROM rulings WHERE docket_id = ?").get(id) as
    | {
        verdict: string;
        award_gbp: number | null;
        ruling_line: string;
        ruling_text: string;
        gates_passed: number | null;
        ruled_at: number;
        review_status: string;
        flags: string;
      }
    | undefined;
  if (ruling) {
    out.ruling = {
      verdict: ruling.verdict,
      awardGbp: ruling.award_gbp,
      rulingLine: ruling.ruling_line,
      rulingText: ruling.ruling_text,
      gatesPassed: ruling.gates_passed,
      ruledAt: ruling.ruled_at,
      reviewStatus: ruling.review_status
    };
    const claim = db
      .prepare("SELECT code, status, award_tokens, expires_at FROM claims WHERE verdict_id = ?")
      .get(id) as { code: string; status: string; award_tokens: string; expires_at: number } | undefined;
    if (claim) {
      // The claim code is public by design: published in the ruling, the
      // ledger, and the X post, per the build guide.
      out.claim = {
        code: claim.code,
        status: claim.status,
        awardTokens: displayTokens(claim.award_tokens),
        expiresAt: claim.expires_at
      };
    }
  }
  return out;
});

app.get("/api/rulings", async (req) => {
  const page = Math.max(1, Number((req.query as { page?: string }).page) || 1);
  const per = 10;
  const total = (db.prepare("SELECT COUNT(*) n FROM rulings").get() as { n: number }).n;
  const rows = db
    .prepare(
      `SELECT r.docket_id, r.verdict, r.award_gbp, r.ruling_line, r.ruled_at,
              d.fee_tokens, p.title, p.amount_gbp
       FROM rulings r
       JOIN dockets d ON d.id = r.docket_id
       JOIN proposals p ON p.id = d.proposal_id
       ORDER BY r.ruled_at DESC LIMIT ? OFFSET ?`
    )
    .all(per, (page - 1) * per) as Array<{
    docket_id: string;
    verdict: string;
    award_gbp: number | null;
    ruling_line: string;
    ruled_at: number;
    fee_tokens: string;
    title: string;
    amount_gbp: number;
  }>;

  const burnPct = runtime.constitution.limits.fee_split.burn;
  return {
    page,
    pages: Math.max(1, Math.ceil(total / per)),
    total,
    items: rows.map((r) => ({
      docketId: r.docket_id,
      verdict: r.verdict,
      awardGbp: r.award_gbp,
      rulingLine: r.ruling_line,
      ruledAt: r.ruled_at,
      title: r.title,
      amountGbp: r.amount_gbp,
      burned: formatWholeTokens(
        (parseBase(r.fee_tokens) * BigInt(Math.round(burnPct * 100))) / 100n,
        cfg.TOKEN_DECIMALS
      )
    }))
  };
});

app.get("/api/stats", async () => {
  const rulings = (db.prepare("SELECT COUNT(*) n FROM rulings").get() as { n: number }).n;
  const approved = (
    db.prepare("SELECT COUNT(*) n FROM rulings WHERE verdict = 'approved'").get() as { n: number }
  ).n;

  const burnPct = runtime.constitution.limits.fee_split.burn;
  let burnedBase = 0n;
  const paidFees = db
    .prepare("SELECT fee_tokens FROM dockets WHERE paid_at IS NOT NULL")
    .all() as Array<{ fee_tokens: string }>;
  for (const row of paidFees) {
    burnedBase += (parseBase(row.fee_tokens) * BigInt(Math.round(burnPct * 100))) / 100n;
  }

  let fee: { tokens: string; usdTarget: number } | null = null;
  try {
    const q = runtime.quoteFee();
    fee = { tokens: formatWholeTokens(q.feeBase, cfg.TOKEN_DECIMALS), usdTarget: q.feeUsdTarget };
  } catch {
    fee = null;
  }

  return {
    rulings,
    approved,
    approvalRate: rulings ? Math.round((approved / rulings) * 1000) / 10 : 0,
    burned: formatWholeTokens(burnedBase, cfg.TOKEN_DECIMALS),
    treasuryUsd: await runtime.treasuryUsd().catch(() => null),
    fee,
    paused: runtime.isPaused(),
    cycle: Number(kvGet(db, "cycle") ?? "1")
  };
});

const ClaimBody = z.object({
  code: z.string().trim(),
  address: z.string().trim(),
  addressConfirm: z.string().trim()
});

app.post(
  "/api/claim",
  { config: { rateLimit: { max: 5, timeWindow: 60_000 } } },
  async (req, reply) => {
    const parsed = ClaimBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid" });
    const { code, address, addressConfirm } = parsed.data;
    if (address !== addressConfirm) {
      return reply.code(400).send({ error: "address_mismatch", message: "The two addresses do not match." });
    }
    try {
      submitClaim(db, code.toLowerCase(), address);
    } catch (e) {
      if (e instanceof UnknownClaimError) return reply.code(404).send({ error: "unknown_code", message: "No such claim code." });
      if (e instanceof AlreadyClaimedError) return reply.code(409).send({ error: "already_claimed", message: "That code has already been used." });
      if (e instanceof ExpiredClaimError) return reply.code(410).send({ error: "expired", message: "Expired. The money went back to the treasury. The ledger says so." });
      if (e instanceof InvalidAddressError) return reply.code(400).send({ error: "bad_address", message: "That is not a valid Solana address." });
      throw e;
    }
    return { ok: true, message: "Recorded. The multisig executes payouts in batches. Check the ledger." };
  }
);

app.get("/r/:id", async (req, reply) => {
  const { id } = req.params as { id: string };
  const row = db
    .prepare(
      `SELECT r.verdict, r.award_gbp, r.ruling_line, r.ruling_text, r.ruled_at, p.title, p.amount_gbp
       FROM rulings r JOIN dockets d ON d.id = r.docket_id JOIN proposals p ON p.id = d.proposal_id
       WHERE r.docket_id = ?`
    )
    .get(id) as
    | { verdict: string; award_gbp: number | null; ruling_line: string; ruling_text: string; ruled_at: number; title: string; amount_gbp: number }
    | undefined;
  if (!row) return reply.code(404).type("text/html").send("<h1>No such docket.</h1>");

  const verdict = row.verdict === "approved" ? `APPROVED · £${row.award_gbp}` : row.verdict.toUpperCase();
  const title = `Docket ${esc(id)} — ${esc(verdict)} — DEREK`;
  return reply.type("text/html").send(`<!DOCTYPE html>
<html lang="en-GB"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta property="og:title" content="${title}">
<meta property="og:description" content="${esc(row.ruling_line)}">
<meta property="og:type" content="article">
<link rel="stylesheet" href="/css/site.css">
</head><body>
<main class="wrap" style="padding-top:46px;">
  <p class="hero__eyebrow">Docket ${esc(id)} · ${esc(row.verdict)}</p>
  <h1 class="sect__title" style="max-width:24ch;">${esc(row.title)}</h1>
  <p class="card__foot" style="margin-top:6px;">Requested £${row.amount_gbp}${row.award_gbp !== null ? ` · awarded £${row.award_gbp}` : ""}</p>
  <div class="output is-live is-done" style="margin-top:26px;"><div class="output__text">${esc(row.ruling_text)}</div></div>
  <p style="margin-top:26px;"><a class="hero__cta" href="/">Back to DEREK</a></p>
</main>
</body></html>`);
});

app.get("/healthz", async () => ({ ok: true, paused: runtime.isPaused() }));

try {
  await app.listen({ port: cfg.PORT, host: "0.0.0.0" });
  log.info({ port: cfg.PORT, paused: runtime.isPaused(), embedWorker: cfg.EMBED_WORKER }, "derek api up");
} catch (e) {
  log.fatal({ err: (e as Error).message }, "listen failed");
  process.exit(1);
}
