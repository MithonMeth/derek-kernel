import { join } from "node:path";
import type { Config } from "./config.js";
import type { Logger } from "./logger.js";
import { openDb, kvGet, kvSet, nextDocketNumber, type DB } from "./db.js";
import type { FinalRuling } from "./guards.js";
import { loadConstitution, type Constitution } from "./constitution.js";
import { Oracle, type FeeQuote } from "./oracle.js";
import { dexScreenerFetcher, dexPaprikaFetcher } from "./fetchers.js";
import { SolanaRpcClient, type ChainClient } from "./chain.js";
import { HdAddressDeriver, type AddressDeriver } from "./deposits.js";
import { AnthropicRulingModel, RULING_MODEL, runRulingPipeline, type RulingModel } from "./pipeline.js";
import { underDailyCap } from "./spend.js";
import { watchPayments, expireDockets } from "./dockets.js";
import { currentCycle, cycleSlotFree } from "./cycles.js";
import { createClaim, expireClaims } from "./claims.js";
import { publishRuling, type PostTransport } from "./publisher.js";
import { getUsdPerGbp } from "./fx.js";
import { baseToUsd } from "./amounts.js";

export interface JudgeContext {
  capGbp: number;
  usdPerGbp: number;
  price: { priceUsd: number } | null;
}

export interface JudgedRuling extends FinalRuling {
  docketId: string;
  review: string;
  cycle: number;
  costUsd: number;
}

export interface RuntimeOverrides {
  db?: DB;
  model?: RulingModel | null;
  chain?: ChainClient | null;
  deriver?: AddressDeriver | null;
  transport?: PostTransport | null;
}

/**
 * Wires config into the working parts and runs the periodic cycles. The
 * API server and the worker both drive one of these; on a single-dyno
 * deploy the API embeds it so there is exactly one database.
 */
export class Runtime {
  readonly db: DB;
  readonly cfg: Config;
  readonly constitution: Constitution;
  readonly oracle: Oracle;
  readonly deriver: AddressDeriver | null;
  readonly chain: ChainClient | null;
  readonly model: RulingModel | null;
  readonly transport: PostTransport | null;
  private log: Logger;
  private timers: NodeJS.Timeout[] = [];

  constructor(cfg: Config, constitutionDir: string, log: Logger, o: RuntimeOverrides = {}) {
    this.cfg = cfg;
    this.log = log;
    // Constitution first: an unreadable or inconsistent constitution
    // refuses boot before anything else starts.
    this.constitution = loadConstitution(constitutionDir);
    log.info(
      { commit: this.constitution.commit, sha256: this.constitution.sha256 },
      "constitution loaded"
    );

    this.db = o.db ?? openDb(join(cfg.DATA_DIR, "derek.db"));

    const fetchers =
      cfg.TOKEN_MINT_ADDRESS !== undefined
        ? [
            dexScreenerFetcher(cfg.CHAIN_ID, cfg.TOKEN_MINT_ADDRESS),
            dexPaprikaFetcher(cfg.CHAIN_ID, cfg.TOKEN_MINT_ADDRESS)
          ]
        : [];
    this.oracle = new Oracle(
      this.db,
      {
        feeTargetUsd: cfg.FEE_TARGET_USD,
        minLiquidityUsd: cfg.MIN_LIQUIDITY_USD,
        tokenDecimals: cfg.TOKEN_DECIMALS
      },
      fetchers,
      log
    );

    this.chain =
      o.chain !== undefined ? o.chain : cfg.RPC_URL ? new SolanaRpcClient(cfg.RPC_URL) : null;
    this.deriver =
      o.deriver !== undefined
        ? o.deriver
        : cfg.DEPOSIT_MASTER_SEED
          ? new HdAddressDeriver(cfg.DEPOSIT_MASTER_SEED)
          : null;
    this.model =
      o.model !== undefined
        ? o.model
        : cfg.ANTHROPIC_API_KEY
          ? new AnthropicRulingModel(cfg.ANTHROPIC_API_KEY)
          : null;
    // No X transport yet: rulings queue for manual posting (`npm run admin queue`).
    this.transport = o.transport ?? null;
  }

  /** Runtime kill switch: the db flag wins over the env default, so `admin unpause` needs no redeploy. */
  isPaused(): boolean {
    const flag = kvGet(this.db, "paused");
    return flag !== null ? flag === "true" : this.cfg.PAUSED;
  }

  setPaused(paused: boolean): void {
    kvSet(this.db, "paused", String(paused));
  }

  quoteFee(now?: number): FeeQuote {
    return this.oracle.quoteFee(now);
  }

  async treasuryUsd(now: number = Date.now()): Promise<number | null> {
    if (this.cfg.FAKE_TREASURY_USD !== undefined) return this.cfg.FAKE_TREASURY_USD;
    const price = this.oracle.current(now);
    if (!this.chain || !this.cfg.TREASURY_ADDRESS || !this.cfg.TOKEN_MINT_ADDRESS || !price) {
      return null;
    }
    const base = await this.chain.getTokenBalanceBase(
      this.cfg.TREASURY_ADDRESS,
      this.cfg.TOKEN_MINT_ADDRESS
    );
    return baseToUsd(base, this.cfg.TOKEN_DECIMALS, price.priceUsd);
  }

  async watchCycle(now: number = Date.now()): Promise<void> {
    expireDockets(this.db, now);
    expireClaims(this.db, now);
    if (this.chain && this.cfg.TOKEN_MINT_ADDRESS) {
      await watchPayments(this.db, this.chain, this.cfg.TOKEN_MINT_ADDRESS, now, this.log);
    }
  }

  /**
   * The numbers a ruling is measured against, resolved once per cycle.
   * Null when the treasury cannot be valued — no cap, no ruling.
   */
  async judgeContext(now: number = Date.now()): Promise<JudgeContext | null> {
    const treasuryUsd = await this.treasuryUsd(now);
    if (treasuryUsd === null) return null;
    const usdPerGbp = await getUsdPerGbp(this.db, this.cfg.FX_FALLBACK_GBP_USD);
    return {
      capGbp: (treasuryUsd * this.constitution.limits.treasury_fraction_cap) / usdPerGbp,
      usdPerGbp,
      price: this.oracle.current(now)
    };
  }

  /**
   * Judge one paid docket and record the result. Shared by the worker's cycle
   * and the dry-run harness, so what an operator reads during the read-through
   * is produced by exactly the code that will rule in production.
   */
  async judgeDocket(
    item: { id: string; title: string; amount_gbp: number; body: string },
    ctx: JudgeContext,
    now: number = Date.now()
  ): Promise<JudgedRuling> {
    const res = await runRulingPipeline(
      this.db,
      this.model!,
      { docketId: item.id, title: item.title, amountGbp: item.amount_gbp, body: item.body },
      { constitutionText: this.constitution.text, limits: this.constitution.limits, capGbp: ctx.capGbp }
    );

    const approved = res.ruling.verdict === "approved";
    const cycle = currentCycle(this.db, now);
    // Constitution s7: one approval per cycle. A second approvable proposal
    // is held for countersign rather than rewritten into a rejection — the
    // ruling stands, the money just does not move today.
    const slotFree = cycleSlotFree(this.db, cycle, this.constitution.limits.approvals_per_cycle);
    // Approvals also need a human countersign until AUTO_APPROVE_UNFLAGGED
    // flips, and always need a live price to lock the token amount.
    // A clamped ruling contradicts itself — the verdict was overridden but
    // the prose still argues the model's case — so it never auto-publishes.
    const review =
      res.ruling.clamped ||
      (approved && (!this.cfg.AUTO_APPROVE_UNFLAGGED || !ctx.price || !slotFree))
        ? "pending_review"
        : "auto";
    if (res.ruling.clamped) {
      this.log.warn(
        { docket: item.id, reason: res.ruling.clamped },
        "verdict clamped — holding, the ruling text still reads as an approval"
      );
    }
    if (approved && !slotFree) {
      this.log.warn(
        { docket: item.id, cycle },
        "cycle approval already spent — holding this one for countersign"
      );
    }

    this.db
      .prepare(
        `INSERT INTO rulings (docket_id, verdict, award_gbp, ruling_line, ruling_text, flags,
           gates_passed, model, ruled_at, review_status, cycle)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        item.id,
        res.ruling.verdict,
        res.ruling.awardGbp,
        res.ruling.rulingLine,
        res.ruling.rulingText,
        JSON.stringify(res.ruling.flags),
        res.ruling.gatesPassed,
        RULING_MODEL,
        now,
        review,
        cycle
      );
    this.db.prepare("UPDATE dockets SET status = 'judged' WHERE id = ?").run(item.id);

    if (approved && review === "auto" && ctx.price) {
      createClaim(
        this.db,
        item.id,
        res.ruling.awardGbp!,
        ctx.price.priceUsd,
        ctx.usdPerGbp,
        this.cfg.TOKEN_DECIMALS,
        this.cfg.CLAIM_EXPIRY_DAYS,
        now
      );
    }
    this.log.info(
      { docket: item.id, verdict: res.ruling.verdict, costUsd: res.costUsd },
      "ruling issued"
    );
    return { ...res.ruling, docketId: item.id, review, cycle, costUsd: res.costUsd };
  }

  /** Judge paid dockets, respecting the pause flag and the daily API cap. */
  async rulingCycle(now: number = Date.now()): Promise<void> {
    if (this.isPaused() || !this.model) return;
    if (!underDailyCap(this.db, this.cfg.MAX_DAILY_API_USD, now)) {
      this.log.warn("daily API cap reached — paid dockets stay queued until tomorrow");
      return;
    }

    const ctx = await this.judgeContext(now);
    if (ctx === null) {
      this.log.warn("no treasury valuation available — ruling deferred");
      return;
    }

    const queue = this.db
      .prepare(
        `SELECT d.id, p.title, p.amount_gbp, p.body
         FROM dockets d JOIN proposals p ON p.id = d.proposal_id
         WHERE d.status = 'paid' AND d.judge_attempts < 3
         ORDER BY d.paid_at LIMIT 5`
      )
      .all() as Array<{ id: string; title: string; amount_gbp: number; body: string }>;

    for (const item of queue) {
      if (!underDailyCap(this.db, this.cfg.MAX_DAILY_API_USD, now)) return;
      try {
        await this.judgeDocket(item, ctx, now);
      } catch (e) {
        this.db.prepare("UPDATE dockets SET judge_attempts = judge_attempts + 1 WHERE id = ?").run(item.id);
        this.log.error({ docket: item.id, err: (e as Error).message }, "pipeline failed");
      }
    }
  }

  /**
   * Push a proposal straight through the pipeline with no payment, for the
   * read-through the launch order calls for. It persists like any other
   * ruling so it shows up in the decision log — point DATA_DIR at a scratch
   * directory unless you mean to keep them.
   */
  async dryRun(
    proposal: { title: string; amountGbp: number; body: string },
    now: number = Date.now()
  ): Promise<JudgedRuling> {
    if (!this.model) throw new Error("no ANTHROPIC_API_KEY configured");
    const ctx = await this.judgeContext(now);
    if (ctx === null) {
      throw new Error("no treasury valuation — set FAKE_TREASURY_USD for a dry run");
    }

    const id = `D-${nextDocketNumber(this.db)}`;
    const proposalId = `dry-${id}`;
    this.db
      .prepare("INSERT INTO proposals (id, title, amount_gbp, body, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(proposalId, proposal.title, proposal.amountGbp, proposal.body, now);
    this.db
      .prepare(
        `INSERT INTO dockets (id, proposal_id, deposit_address, derivation_index, fee_tokens,
           fee_usd_target, price_usd_at_quote, quoted_at, paid_at, status)
         VALUES (?, ?, 'dry-run', -1, '0', 0, 0, ?, ?, 'paid')`
      )
      .run(id, proposalId, now, now);

    return this.judgeDocket(
      { id, title: proposal.title, amount_gbp: proposal.amountGbp, body: proposal.body },
      ctx,
      now
    );
  }

  async publishCycle(): Promise<void> {
    const pending = this.db
      .prepare(
        "SELECT docket_id FROM rulings WHERE post_status = 'unposted' AND review_status != 'pending_review' LIMIT 5"
      )
      .all() as Array<{ docket_id: string }>;
    for (const row of pending) {
      await publishRuling(
        this.db,
        this.transport,
        row.docket_id,
        {
          siteUrl: this.cfg.SITE_URL,
          tokenDecimals: this.cfg.TOKEN_DECIMALS,
          burnFraction: this.constitution.limits.fee_split.burn
        },
        this.log
      );
    }
  }

  start(): void {
    const safely = (name: string, fn: () => Promise<void>) => (): void => {
      fn().catch((e) => this.log.error({ err: (e as Error).message }, `${name} cycle failed`));
    };
    this.timers = [
      setInterval(safely("price", () => this.oracle.poll()), 60_000),
      setInterval(safely("watch", () => this.watchCycle()), 30_000),
      setInterval(safely("ruling", () => this.rulingCycle()), 60_000),
      setInterval(safely("publish", () => this.publishCycle()), 60_000)
    ];
    for (const t of this.timers) t.unref();
    void this.oracle.poll().catch(() => undefined);
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
  }
}
