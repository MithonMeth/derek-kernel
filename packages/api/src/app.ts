import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import compress from "@fastify/compress";
import QRCode from "qrcode";
import { randomUUID, timingSafeEqual as nodeTimingSafeEqual } from "node:crypto";
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
  currentCycle,
  daysSinceLastApproval,
  formatWholeTokens,
  parseBase,
  renderRulingCard,
  normaliseHandle,
  submitClaim,
  type Config,
  type DocketRow
} from "@derek/core";

/**
 * Builds the HTTP surface. Separated from the entrypoint so tests can drive
 * it with app.inject() against a scratch database — the endpoints are where
 * an unawaited promise turns into a wrong answer rather than a crash.
 */
export async function buildApp(runtime: Runtime, cfg: Config) {
  const webRoot = fileURLToPath(new URL("../../web/public", import.meta.url));
  const log = runtime.log;
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

  /** Constant-time compare; lengths differ often enough to leak otherwise. */
  function timingSafeEqual(a: string, b: string): boolean {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    return ab.length === bb.length && nodeTimingSafeEqual(ab, bb);
  }

  const esc = (s: string): string =>
    s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

  function displayTokens(base: string): string {
    return formatWholeTokens(parseBase(base), cfg.TOKEN_DECIMALS);
  }

  const ProposalBody = z.object({
    title: z.string().trim().min(1).max(120),
    amountUsd: z.number().finite().gt(0).lte(1_000_000),
    body: z.string().trim().min(1).max(2000),
    // Optional and never verified. Normalised again in the renderer.
    xHandle: z.string().trim().max(20).optional()
  });

  app.post(
    "/api/proposals",
    { config: { rateLimit: { max: 10, timeWindow: 60_000 } } },
    async (req, reply) => {
      const parsed = ProposalBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid", message: "Name the thing, give a number, write the proposal." });
      }
      if (await runtime.isPaused()) {
        return reply.code(503).send({ error: "paused", message: "Intake is paused. Derek is being commissioned." });
      }
      if (!runtime.deriver) {
        // Publicly reachable once unpaused but before the token exists, so
        // this is written for a visitor rather than for a developer.
        return reply.code(503).send({
          error: "no_deposits",
          message: "There is nowhere to send a fee yet. The token is not minted."
        });
      }
      const hourAgo = Date.now() - 3_600_000;
      const recent = Number(
        (await db.row<{ n: string }>("SELECT COUNT(*) AS n FROM dockets WHERE quoted_at > $1", [hourAgo]))!.n
      );
      if (recent >= cfg.MAX_SUBMISSIONS_PER_HOUR) {
        return reply.code(429).send({ error: "backlog", message: "There is a backlog. Derek reads at his own pace." });
      }

      let quote;
      try {
        quote = await runtime.quoteFee();
      } catch (e) {
        if (e instanceof SubmissionsPausedError) {
          return reply.code(503).send({ error: "no_price", message: "No defensible price is available. Submissions are paused." });
        }
        throw e;
      }

      const proposalId = randomUUID();
      const p = parsed.data;
      await db.run(
        "INSERT INTO proposals (id, title, amount_usd, body, created_at, x_handle) VALUES ($1, $2, $3, $4, $5, $6)",
        [proposalId, p.title, p.amountUsd, p.body, Date.now(), normaliseHandle(p.xHandle)]
      );
      const docket = await createDocket(db, runtime.deriver, quote, proposalId);

      const uiAmount = baseToWholeTokens(quote.feeBase, cfg.TOKEN_DECIMALS).toString();
      const payUri = cfg.TOKEN_MINT_ADDRESS
        ? `solana:${docket.deposit_address}?amount=${uiAmount}&spl-token=${cfg.TOKEN_MINT_ADDRESS}`
        : `solana:${docket.deposit_address}`;
      const qrDataUrl = await QRCode.toDataURL(payUri, { margin: 1, width: 240 });

      return {
        docketId: docket.id,
        // Shown once, here. It is what later releases the claim code, so the
        // page stores it locally and the ledger never sees it.
        viewToken: docket.view_token,
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
    const docket = await db.row<DocketRow>("SELECT * FROM dockets WHERE id = $1", [id]);
    if (!docket) return reply.code(404).send({ error: "not_found" });

    const out: Record<string, unknown> = {
      docketId: docket.id,
      status: docket.status,
      depositAddress: docket.deposit_address,
      feeTokens: displayTokens(docket.fee_tokens),
      quoteExpiresAt: docket.quoted_at + QUOTE_TTL_MS,
      paidAt: docket.paid_at
    };

    const ruling = await db.row<{
      verdict: string;
      award_usd: number | null;
      ruling_line: string;
      ruling_text: string;
      gates_passed: number | null;
      ruled_at: number;
      review_status: string;
      flags: string;
    }>("SELECT * FROM rulings WHERE docket_id = $1", [id]);
    if (ruling) {
      out.ruling = {
        verdict: ruling.verdict,
        awardUsd: ruling.award_usd,
        rulingLine: ruling.ruling_line,
        rulingText: ruling.ruling_text,
        gatesPassed: ruling.gates_passed,
        ruledAt: ruling.ruled_at,
        reviewStatus: ruling.review_status
      };
      const claim = await db.row<{
        code: string;
        status: string;
        award_tokens: string;
        expires_at: number;
      }>("SELECT code, status, award_tokens, expires_at FROM claims WHERE verdict_id = $1", [id]);
      if (claim) {
        // Everything about a claim is public except the code itself. The
        // code is a bearer token for the money: docket ids are sequential,
        // so publishing it here would let anyone walk the range and
        // redirect an award to their own wallet before the winner looked.
        out.claim = {
          status: claim.status,
          awardTokens: displayTokens(claim.award_tokens),
          expiresAt: claim.expires_at
        };
        const token = (req.query as { t?: string }).t;
        if (docket.view_token && token && timingSafeEqual(token, docket.view_token)) {
          (out.claim as Record<string, unknown>).code = claim.code;
        }
      }
    }
    return out;
  });

  app.get("/api/rulings", async (req) => {
    const query = req.query as { page?: string; detail?: string };
    const page = Math.max(1, Number(query.page) || 1);
    // The decision log needs the proposal text and the full ruling; the
    // homepage ledger does not, and they add up quickly.
    const detail = query.detail === "1";
    const per = 10;
    const total = Number((await db.row<{ n: string }>("SELECT COUNT(*) AS n FROM rulings"))!.n);
    const rows = await db.rows<{
      docket_id: string;
      verdict: string;
      award_usd: number | null;
      ruling_line: string;
      ruling_text: string;
      ruled_at: number;
      gates_passed: number | null;
      flags: string;
      review_status: string;
      cycle: number | null;
      fee_tokens: string;
      title: string;
      amount_usd: number;
      body: string;
    }>(
      `SELECT r.docket_id, r.verdict, r.award_usd, r.ruling_line, r.ruling_text, r.ruled_at,
              r.gates_passed, r.flags, r.review_status, r.cycle,
              d.fee_tokens, p.title, p.amount_usd, p.body
       FROM rulings r
       JOIN dockets d ON d.id = r.docket_id
       JOIN proposals p ON p.id = d.proposal_id
       ORDER BY r.ruled_at DESC LIMIT $1 OFFSET $2`,
      [per, (page - 1) * per]
    );

    const burnPct = runtime.constitution.limits.fee_split.burn;
    return {
      page,
      pages: Math.max(1, Math.ceil(total / per)),
      total,
      items: rows.map((r) => {
        const base = {
          docketId: r.docket_id,
          verdict: r.verdict,
          awardUsd: r.award_usd,
          rulingLine: r.ruling_line,
          ruledAt: r.ruled_at,
          title: r.title,
          amountUsd: r.amount_usd,
          burned: formatWholeTokens(
            (parseBase(r.fee_tokens) * BigInt(Math.round(burnPct * 100))) / 100n,
            cfg.TOKEN_DECIMALS
          )
        };
        if (!detail) return base;
        return {
          ...base,
          proposal: r.body,
          rulingText: r.ruling_text,
          gatesPassed: r.gates_passed,
          flags: JSON.parse(r.flags || "[]") as string[],
          // A held approval is a real ruling that has not released money.
          held: r.verdict === "approved" && r.review_status === "pending_review",
          cycle: r.cycle
        };
      })
    };
  });

  app.get("/api/stats", async () => {
    const rulings = Number((await db.row<{ n: string }>("SELECT COUNT(*) AS n FROM rulings"))!.n);
    const approved = Number(
      (await db.row<{ n: string }>(
        "SELECT COUNT(*) AS n FROM rulings WHERE verdict = 'approved'"
      ))!.n
    );

    const burnPct = runtime.constitution.limits.fee_split.burn;
    let burnedBase = 0n;
    const paidFees = await db.rows<{ fee_tokens: string }>(
      "SELECT fee_tokens FROM dockets WHERE paid_at IS NOT NULL"
    );
    for (const row of paidFees) {
      burnedBase += (parseBase(row.fee_tokens) * BigInt(Math.round(burnPct * 100))) / 100n;
    }

    const treasuryBase = await runtime.treasuryTokens();
    const treasuryTokens =
      treasuryBase === null ? null : formatWholeTokens(treasuryBase, cfg.TOKEN_DECIMALS);

    let fee: { tokens: string; usdTarget: number } | null = null;
    try {
      const q = await runtime.quoteFee();
      fee = { tokens: formatWholeTokens(q.feeBase, cfg.TOKEN_DECIMALS), usdTarget: q.feeUsdTarget };
    } catch {
      fee = null;
    }

    return {
      rulings,
      approved,
      approvalRate: rulings ? Math.round((approved / rulings) * 1000) / 10 : 0,
      burned: formatWholeTokens(burnedBase, cfg.TOKEN_DECIMALS),
      mint: cfg.TOKEN_MINT_ADDRESS ?? null,
      treasuryUsd: await runtime.treasuryUsd().catch(() => null),
      treasuryTokens,
      fee,
      paused: await runtime.isPaused(),
      cycle: await currentCycle(db),
      daysSinceApproval: await daysSinceLastApproval(db),
      maxAward: runtime.constitution.limits.max_award_usd,
      minAward: runtime.constitution.limits.min_award_usd,
      constitution: {
        commit: runtime.constitution.commit,
        sha256: runtime.constitution.sha256
      }
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
        await submitClaim(db, code.toLowerCase(), address);
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

  app.get("/card/:id.png", async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = await db.row<{
      docket_id: string;
      verdict: string;
      ruling_line: string;
      fee_tokens: string;
      amount_usd: number;
      award_usd: number | null;
      x_handle: string | null;
    }>(
      `SELECT r.docket_id, r.verdict, r.ruling_line, d.fee_tokens, p.amount_usd, r.award_usd, p.x_handle
       FROM rulings r JOIN dockets d ON d.id = r.docket_id JOIN proposals p ON p.id = d.proposal_id
       WHERE r.docket_id = $1`,
      [id]
    );
    if (!row) return reply.code(404).send({ error: "not_found" });

    const burnFraction = runtime.constitution.limits.fee_split.burn;
    const burnedBase = (parseBase(row.fee_tokens) * BigInt(Math.round(burnFraction * 100))) / 100n;
    const png = renderRulingCard({
      docketId: row.docket_id,
      verdict: row.verdict,
      rulingLine: row.ruling_line,
      amountUsd: row.amount_usd,
      awardUsd: row.award_usd,
      burnedTokens: formatWholeTokens(burnedBase, cfg.TOKEN_DECIMALS),
      siteHost: cfg.SITE_URL.replace(/^https?:\/\//, "").replace(/\/$/, ""),
      xHandle: row.x_handle
    });
    // A ruling never changes once issued, so this is safe to cache hard.
    return reply
      .type("image/png")
      .header("cache-control", "public, max-age=604800, immutable")
      .send(png);
  });

  app.get("/r/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = await db.row<{
      verdict: string;
      award_usd: number | null;
      ruling_line: string;
      ruling_text: string;
      ruled_at: number;
      title: string;
      amount_usd: number;
    }>(
      `SELECT r.verdict, r.award_usd, r.ruling_line, r.ruling_text, r.ruled_at, p.title, p.amount_usd
       FROM rulings r JOIN dockets d ON d.id = r.docket_id JOIN proposals p ON p.id = d.proposal_id
       WHERE r.docket_id = $1`,
      [id]
    );
    if (!row) return reply.code(404).type("text/html").send("<h1>No such docket.</h1>");

    const verdict = row.verdict === "approved" ? `APPROVED · $${row.award_usd}` : row.verdict.toUpperCase();
    const title = `Docket ${esc(id)} — ${esc(verdict)} — DEREK`;
    return reply.type("text/html").send(`<!DOCTYPE html>
  <html lang="en-GB"><head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <meta property="og:title" content="${title}">
  <meta property="og:description" content="${esc(row.ruling_line)}">
  <meta property="og:type" content="article">
  <meta property="og:image" content="${cfg.SITE_URL.replace(/\/$/, "")}/card/${encodeURIComponent(id)}.png">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="628">
  <meta name="twitter:card" content="summary_large_image">
  <link rel="stylesheet" href="/css/site.css">
  </head><body>
  <main class="wrap" style="padding-top:46px;">
    <p class="hero__eyebrow">Docket ${esc(id)} · ${esc(row.verdict)}</p>
    <h1 class="sect__title" style="max-width:24ch;">${esc(row.title)}</h1>
    <p class="card__foot" style="margin-top:6px;">Requested $${row.amount_usd}${row.award_usd !== null ? ` · awarded $${row.award_usd}` : ""}</p>
    <div class="output is-live is-done" style="margin-top:26px;"><div class="output__text">${esc(row.ruling_text)}</div></div>
    <p style="margin-top:26px;"><a class="hero__cta" href="/">Back to DEREK</a></p>
  </main>
  </body></html>`);
  });

  app.get("/healthz", async () => ({ ok: true, paused: await runtime.isPaused() }));


  return app;
}
