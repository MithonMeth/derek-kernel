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
import { underDailyCap, underXDailyCap, todayXSpendUsd } from "./spend.js";
import { watchPayments, expireDockets } from "./dockets.js";
import { currentCycle, cycleSlotFree } from "./cycles.js";
import { createClaim, expireClaims } from "./claims.js";
import { publishRuling, type PostTransport } from "./publisher.js";
import { baseToUsd, wholeTokensToBase } from "./amounts.js";
import { base58Decode, base58Encode } from "./base58.js";
import { ed25519 } from "@noble/curves/ed25519";
import {
  SweepConfigError,
  planSweeps,
  runSweep,
  type SweepExecutor,
  type SweepPlan,
  type SweepResult
} from "./sweeper.js";
import { SolanaSweepExecutor } from "./solana-sweep.js";
import { XTransport } from "./x-transport.js";

function buildXTransport(cfg: Config, log: Logger): XTransport | null {
  const { X_CONSUMER_KEY, X_CONSUMER_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET } = cfg;
  if (!X_CONSUMER_KEY || !X_CONSUMER_SECRET || !X_ACCESS_TOKEN || !X_ACCESS_SECRET) {
    return null;
  }
  return new XTransport(
    {
      consumerKey: X_CONSUMER_KEY,
      consumerSecret: X_CONSUMER_SECRET,
      accessToken: X_ACCESS_TOKEN,
      accessSecret: X_ACCESS_SECRET,
      userId: cfg.X_USER_ID
    },
    log
  );
}

export interface JudgeContext {
  capUsd: number;
  price: { priceUsd: number } | null;
}

export interface JudgedRuling extends FinalRuling {
  docketId: string;
  review: string;
  cycle: number;
  costUsd: number;
}

/**
 * Heroku injects DATABASE_URL. There is no local-file fallback on purpose:
 * a dyno's disk does not survive a restart, and silently writing state
 * somewhere ephemeral is how a ledger loses a ruling.
 */
function requireDatabaseUrl(cfg: Config): string {
  if (!cfg.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL is not set. Provision Postgres (heroku addons:create heroku-postgresql) " +
        "or point it at a local instance."
    );
  }
  return cfg.DATABASE_URL;
}

export interface RuntimeOverrides {
  db?: DB;
  model?: RulingModel | null;
  chain?: ChainClient | null;
  deriver?: AddressDeriver | null;
  transport?: PostTransport | null;
  executor?: SweepExecutor | null;
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
  readonly log: Logger;
  private overrideExecutor: SweepExecutor | null | undefined;
  private timers: NodeJS.Timeout[] = [];

  private constructor(
    cfg: Config,
    constitution: Constitution,
    db: DB,
    oracle: Oracle,
    log: Logger,
    o: RuntimeOverrides
  ) {
    this.cfg = cfg;
    this.constitution = constitution;
    this.db = db;
    this.oracle = oracle;
    this.log = log;

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
    // Without all four OAuth values, rulings queue for manual posting
    // (`npm run admin queue`) rather than failing.
    this.transport = o.transport !== undefined ? o.transport : buildXTransport(cfg, log);
    this.overrideExecutor = o.executor;
  }

  static async create(
    cfg: Config,
    constitutionDir: string,
    log: Logger,
    o: RuntimeOverrides = {}
  ): Promise<Runtime> {
    // Constitution first: an unreadable or inconsistent constitution
    // refuses boot before anything else starts.
    const constitution = loadConstitution(constitutionDir);
    log.info(
      { commit: constitution.commit, sha256: constitution.sha256 },
      "constitution loaded"
    );

    const db = o.db ?? (await openDb(requireDatabaseUrl(cfg)));

    const fetchers =
      cfg.TOKEN_MINT_ADDRESS !== undefined
        ? [
            dexScreenerFetcher(cfg.CHAIN_ID, cfg.TOKEN_MINT_ADDRESS),
            dexPaprikaFetcher(cfg.CHAIN_ID, cfg.TOKEN_MINT_ADDRESS)
          ]
        : [];
    const oracle = await Oracle.create(
      db,
      {
        feeTargetUsd: cfg.FEE_TARGET_USD,
        minLiquidityUsd: cfg.MIN_LIQUIDITY_USD,
        tokenDecimals: cfg.TOKEN_DECIMALS
      },
      fetchers,
      log
    );

    checkSweepFeePayer(cfg.SWEEP_FEE_PAYER_SECRET, log);

    return new Runtime(cfg, constitution, db, oracle, log, o);
  }

  /** Runtime kill switch: the db flag wins over the env default, so `admin unpause` needs no redeploy. */
  async isPaused(): Promise<boolean> {
    const flag = await kvGet(this.db, "paused");
    return flag !== null ? flag === "true" : this.cfg.PAUSED;
  }

  async setPaused(paused: boolean): Promise<void> {
    await kvSet(this.db, "paused", String(paused));
  }

  async quoteFee(now?: number): Promise<FeeQuote> {
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
    await expireDockets(this.db, now);
    await expireClaims(this.db, now);
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
    return {
      capUsd: treasuryUsd * this.constitution.limits.treasury_fraction_cap,
      price: this.oracle.current(now)
    };
  }

  /**
   * Judge one paid docket and record the result. Shared by the worker's cycle
   * and the dry-run harness, so what an operator reads during the read-through
   * is produced by exactly the code that will rule in production.
   */
  async judgeDocket(
    item: { id: string; title: string; amount_usd: number; body: string },
    ctx: JudgeContext,
    now: number = Date.now()
  ): Promise<JudgedRuling> {
    const res = await runRulingPipeline(
      this.db,
      this.model!,
      { docketId: item.id, title: item.title, amountUsd: item.amount_usd, body: item.body },
      { constitutionText: this.constitution.text, limits: this.constitution.limits, capUsd: ctx.capUsd }
    );

    const approved = res.ruling.verdict === "approved";
    const cycle = await currentCycle(this.db, now);
    // Constitution s7: one approval per cycle. A second approvable proposal
    // is held for countersign rather than rewritten into a rejection — the
    // ruling stands, the money just does not move today.
    const slotFree = await cycleSlotFree(
      this.db,
      cycle,
      this.constitution.limits.approvals_per_cycle
    );
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

    await this.db.run(
      `INSERT INTO rulings (docket_id, verdict, award_usd, ruling_line, ruling_text, flags,
         gates_passed, model, ruled_at, review_status, cycle)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        item.id,
        res.ruling.verdict,
        res.ruling.awardUsd,
        res.ruling.rulingLine,
        res.ruling.rulingText,
        JSON.stringify(res.ruling.flags),
        res.ruling.gatesPassed,
        RULING_MODEL,
        now,
        review,
        cycle
      ]
    );
    await this.db.run("UPDATE dockets SET status = 'judged' WHERE id = $1", [item.id]);

    if (approved && review === "auto" && ctx.price) {
      await createClaim(
        this.db,
        item.id,
        res.ruling.awardUsd!,
        ctx.price.priceUsd,
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
    if ((await this.isPaused()) || !this.model) return;
    if (!(await underDailyCap(this.db, this.cfg.MAX_DAILY_API_USD, now))) {
      this.log.warn("daily API cap reached — paid dockets stay queued until tomorrow");
      return;
    }

    const ctx = await this.judgeContext(now);
    if (ctx === null) {
      this.log.warn("no treasury valuation available — ruling deferred");
      return;
    }

    const queue = await this.db.rows<{
      id: string;
      title: string;
      amount_usd: number;
      body: string;
    }>(
      `SELECT d.id, p.title, p.amount_usd, p.body
       FROM dockets d JOIN proposals p ON p.id = d.proposal_id
       WHERE d.status = 'paid' AND d.judge_attempts < 3
       ORDER BY d.paid_at LIMIT 5`
    );

    for (const item of queue) {
      if (!(await underDailyCap(this.db, this.cfg.MAX_DAILY_API_USD, now))) return;
      try {
        await this.judgeDocket(item, ctx, now);
      } catch (e) {
        await this.db.run(
          "UPDATE dockets SET judge_attempts = judge_attempts + 1 WHERE id = $1",
          [item.id]
        );
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
    proposal: { title: string; amountUsd: number; body: string },
    now: number = Date.now()
  ): Promise<JudgedRuling> {
    if (!this.model) throw new Error("no ANTHROPIC_API_KEY configured");
    const ctx = await this.judgeContext(now);
    if (ctx === null) {
      throw new Error("no treasury valuation — set FAKE_TREASURY_USD for a dry run");
    }

    const id = `D-${await nextDocketNumber(this.db)}`;
    const proposalId = `dry-${id}`;
    await this.db.run(
      "INSERT INTO proposals (id, title, amount_usd, body, created_at) VALUES ($1, $2, $3, $4, $5)",
      [proposalId, proposal.title, proposal.amountUsd, proposal.body, now]
    );
    await this.db.run(
      `INSERT INTO dockets (id, proposal_id, deposit_address, derivation_index, fee_tokens,
         fee_usd_target, price_usd_at_quote, quoted_at, paid_at, status)
       VALUES ($1, $2, 'dry-run', -1, '0', 0, 0, $3, $4, 'paid')`,
      [id, proposalId, now, now]
    );

    return this.judgeDocket(
      { id, title: proposal.title, amount_usd: proposal.amountUsd, body: proposal.body },
      ctx,
      now
    );
  }

  /**
   * Builds the sweep executor, or explains what is missing. Returns null
   * rather than throwing when sweeping simply is not configured yet, so the
   * worker can run without a token minted.
   */
  sweepExecutor(): SweepExecutor | null {
    if (this.overrideExecutor !== undefined) return this.overrideExecutor;
    const c = this.cfg;
    if (!c.SWEEP_FEE_PAYER_SECRET) return null;
    // Half-configured addresses throw: that is an operator error which must
    // be fixed before anything moves, and staying silent risks sweeping to
    // an address nobody chose.
    if (!c.RPC_URL || !c.TOKEN_MINT_ADDRESS || !c.TREASURY_ADDRESS || !c.AIRDROP_ADDRESS) {
      throw new SweepConfigError(
        "sweeping needs RPC_URL, TOKEN_MINT_ADDRESS, TREASURY_ADDRESS and AIRDROP_ADDRESS"
      );
    }
    // A malformed key only disables sweeping. This runs on every cycle, and
    // a key that cannot be parsed would otherwise raise forever; it is
    // reported once, loudly, at boot instead.
    if (!checkSweepFeePayer(c.SWEEP_FEE_PAYER_SECRET, this.log)) return null;
    return new SolanaSweepExecutor({
      rpcUrl: c.RPC_URL,
      mint: c.TOKEN_MINT_ADDRESS,
      decimals: c.TOKEN_DECIMALS,
      treasuryAddress: c.TREASURY_ADDRESS,
      airdropAddress: c.AIRDROP_ADDRESS,
      feePayerSecret: base58Decode(c.SWEEP_FEE_PAYER_SECRET)
    });
  }

  /** Whole tokens below which a balance is not worth a transaction. */
  dustBase(): bigint {
    return wholeTokensToBase(BigInt(Math.floor(this.cfg.SWEEP_DUST_TOKENS)), this.cfg.TOKEN_DECIMALS);
  }

  /** What a sweep would move right now, without sending anything. */
  async sweepPlans(): Promise<SweepPlan[]> {
    if (!this.chain || !this.cfg.TOKEN_MINT_ADDRESS) return [];
    return planSweeps(
      this.db,
      this.chain,
      this.cfg.TOKEN_MINT_ADDRESS,
      this.constitution.limits,
      this.dustBase(),
      this.log
    );
  }

  async sweepCycle(now: number = Date.now()): Promise<SweepResult[]> {
    const executor = this.sweepExecutor();
    if (!executor || !this.chain || !this.deriver || !this.cfg.TOKEN_MINT_ADDRESS) return [];
    return runSweep(
      {
        db: this.db,
        chain: this.chain,
        executor,
        deriveSigningSeed: (i) => this.deriver!.deriveSigningSeed(i),
        mint: this.cfg.TOKEN_MINT_ADDRESS,
        limits: this.constitution.limits,
        dustBase: this.dustBase(),
        log: this.log
      },
      now
    );
  }

  async publishCycle(): Promise<void> {
    if (this.transport && !(await underXDailyCap(this.db, this.cfg.MAX_DAILY_X_USD))) {
      this.log.warn(
        { spent: await todayXSpendUsd(this.db), cap: this.cfg.MAX_DAILY_X_USD },
        "daily X spend cap reached — rulings stay queued until tomorrow"
      );
      return;
    }
    const pending = await this.db.rows<{ docket_id: string }>(
      "SELECT docket_id FROM rulings WHERE post_status = 'unposted' AND review_status <> 'pending_review' LIMIT 5"
    );
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
      setInterval(safely("publish", () => this.publishCycle()), 60_000),
    ];
    if (this.cfg.SWEEP_AUTO) {
      // Slow on purpose: sweeping moves money, and there is no hurry.
      this.timers.push(
        setInterval(safely("sweep", async () => void (await this.sweepCycle())), 300_000)
      );
    } else {
      this.log.info("automatic sweeping is off; run `admin sweep --send` to move fees");
    }
    for (const t of this.timers) t.unref();
    void this.oracle.poll().catch(() => undefined);
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
  }
}

/**
 * Confirms the sweep fee payer key is well-formed at boot and reports the
 * public key it resolves to, so an operator can check it against the wallet
 * they actually funded. Without this the key is first decoded during a
 * sweep, which is the worst moment to discover a typo: fees are already
 * sitting in deposit addresses by then.
 *
 * A bad key does not stop the process. Rulings do not depend on sweeping,
 * and taking a live public site down over a misconfigured payout wallet is
 * the worse failure. It is logged at error level and sweeping stays off.
 */
export function checkSweepFeePayer(secret: string | undefined, log: Logger): string | null {
  if (!secret) return null;
  let bytes: Uint8Array;
  try {
    bytes = base58Decode(secret);
  } catch {
    log.error("SWEEP_FEE_PAYER_SECRET is not valid base58; sweeping disabled");
    return null;
  }
  if (bytes.length !== 64) {
    log.error(
      { length: bytes.length },
      "SWEEP_FEE_PAYER_SECRET is not a 64-byte Solana keypair; sweeping disabled"
    );
    return null;
  }
  // A Solana secret key is seed || public key. If the stored half and the
  // half derived from the seed disagree, the key is corrupt and every
  // signature it produces would be rejected.
  const stored = base58Encode(bytes.slice(32));
  const derived = base58Encode(ed25519.getPublicKey(bytes.slice(0, 32)));
  if (stored !== derived) {
    log.error("SWEEP_FEE_PAYER_SECRET is internally inconsistent; sweeping disabled");
    return null;
  }
  log.info({ feePayer: derived }, "sweep fee payer loaded");
  return derived;
}
