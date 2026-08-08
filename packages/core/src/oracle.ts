import type { DB } from "./db.js";
import { kvGet, kvSet } from "./db.js";
import { wholeTokensToBase } from "./amounts.js";
import type { Logger } from "./logger.js";

export interface PriceObservation {
  priceUsd: number;
  liquidityUsd: number;
  source: string;
  observedAt: number;
}

export type PriceFetcher = () => Promise<PriceObservation>;

export interface OracleConfig {
  feeTargetUsd: number;
  /** Flat fee in whole tokens. Wins over feeTargetUsd and needs no price. */
  feeFixedTokens?: number;
  minLiquidityUsd: number;
  tokenDecimals: number;
  /** After this long without a good tick, stop quoting and pause intake. */
  staleAfterMs?: number;
  medianWindowMs?: number;
  bandLow?: number;
  bandHigh?: number;
  maxFeeMultiple?: number;
}

export interface FeeQuote {
  feeBase: bigint; // token base units
  feeUsdTarget: number;
  priceUsd: number;
  quotedAt: number;
  frozen: boolean;
}

/** Quote validity and late-payment tolerance, per the build guide. */
export const QUOTE_TTL_MS = 15 * 60_000;
export const PAY_TOLERANCE = 0.2;

export class SubmissionsPausedError extends Error {
  constructor(reason: string) {
    super(`submissions paused: ${reason}`);
  }
}

/**
 * The fee is a USD target repriced from on-chain data, so the number of
 * tokens a submission costs scales inversely with the token's price. Every
 * guard in here exists to stop a junk tick from producing a junk fee.
 */
export class Oracle {
  private last: PriceObservation | null = null;
  private frozen = false;

  private constructor(
    private db: DB,
    private cfg: OracleConfig,
    private fetchers: PriceFetcher[],
    private log?: Logger
  ) {}

  /** Loads whatever state survived the last restart. */
  static async create(
    db: DB,
    cfg: OracleConfig,
    fetchers: PriceFetcher[],
    log?: Logger
  ): Promise<Oracle> {
    const oracle = new Oracle(db, cfg, fetchers, log);
    const persisted = await kvGet(db, "oracle_last_tick");
    if (persisted) oracle.last = JSON.parse(persisted) as PriceObservation;
    oracle.frozen = (await kvGet(db, "oracle_frozen")) === "true";
    return oracle;
  }

  /** Called every ~60s by the worker. Never per-request. */
  async poll(now: number = Date.now()): Promise<void> {
    // Pre-mint there is no token to price. That is an expected state, not a
    // failure — quoteFee() still refuses, which is the behaviour that matters.
    if (this.fetchers.length === 0) return;

    let obs: PriceObservation | null = null;
    for (const fetch of this.fetchers) {
      try {
        obs = await fetch();
        break;
      } catch (e) {
        this.log?.warn({ err: (e as Error).message }, "price fetcher failed");
      }
    }
    if (!obs) {
      this.log?.error("all price sources failed; serving cached price until stale window ends");
      return;
    }
    await this.accept(obs, now);
  }

  /** Separated from poll() so tests can inject observations directly. */
  async accept(obs: PriceObservation, now: number = Date.now()): Promise<void> {
    if (!(obs.priceUsd > 0) || !Number.isFinite(obs.priceUsd)) {
      this.log?.error({ obs }, "rejecting non-positive price tick");
      return;
    }

    const median = await this.medianPrice(now);
    const bandLow = this.cfg.bandLow ?? 0.25;
    const bandHigh = this.cfg.bandHigh ?? 4;
    if (median !== null && (obs.priceUsd < median * bandLow || obs.priceUsd > median * bandHigh)) {
      this.log?.error(
        { price: obs.priceUsd, median, source: obs.source },
        "rejecting price tick outside sanity band; keeping previous"
      );
      return;
    }

    await this.db.run(
      `INSERT INTO price_ticks (observed_at, price_usd, liquidity_usd, source)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (observed_at) DO UPDATE SET
         price_usd = excluded.price_usd,
         liquidity_usd = excluded.liquidity_usd,
         source = excluded.source`,
      [obs.observedAt, obs.priceUsd, obs.liquidityUsd, obs.source]
    );
    this.last = obs;
    await kvSet(this.db, "oracle_last_tick", JSON.stringify(obs));

    if (obs.liquidityUsd < this.cfg.minLiquidityUsd) {
      if (!this.frozen) {
        this.log?.error(
          { liquidityUsd: obs.liquidityUsd, min: this.cfg.minLiquidityUsd },
          "LIQUIDITY BELOW FLOOR — fee frozen at last good value"
        );
      }
      this.frozen = true;
      await kvSet(this.db, "oracle_frozen", "true");
      return;
    }

    if (this.frozen) this.log?.warn("liquidity recovered; fee unfrozen");
    this.frozen = false;
    await kvSet(this.db, "oracle_frozen", "false");

    const feeBase = await this.computeFeeBase(obs.priceUsd, now);
    if (feeBase !== null) await kvSet(this.db, "last_good_fee_base", feeBase.toString());
  }

  current(now: number = Date.now()): PriceObservation | null {
    const staleAfter = this.cfg.staleAfterMs ?? 30 * 60_000;
    if (!this.last) return null;
    if (now - this.last.observedAt > staleAfter) return null;
    return this.last;
  }

  /**
   * The fee for a new docket, in base units. Throws SubmissionsPausedError
   * rather than ever quoting a fee it cannot defend.
   */
  async quoteFee(now: number = Date.now()): Promise<FeeQuote> {
    // A flat token fee is priced by fiat, not by the market, so none of the
    // machinery below applies: no price to be stale, no liquidity to be
    // thin, no median band to breach. It is the only quote that can be
    // served before a token has a market.
    if (this.cfg.feeFixedTokens !== undefined) {
      const obs = this.current(now);
      return {
        feeBase: wholeTokensToBase(BigInt(Math.round(this.cfg.feeFixedTokens)), this.cfg.tokenDecimals),
        // What it happens to be worth today, when that is knowable. It is
        // reporting, not the target - nothing is derived from it.
        feeUsdTarget: obs ? this.cfg.feeFixedTokens * obs.priceUsd : 0,
        priceUsd: obs?.priceUsd ?? 0,
        quotedAt: now,
        frozen: false
      };
    }

    const lastGood = await kvGet(this.db, "last_good_fee_base");

    const obs = this.current(now);
    if (!obs) throw new SubmissionsPausedError("no fresh price for 30 minutes");

    if (this.frozen) {
      if (lastGood === null) throw new SubmissionsPausedError("liquidity floor and no prior fee");
      return {
        feeBase: BigInt(lastGood),
        feeUsdTarget: this.cfg.feeTargetUsd,
        priceUsd: obs.priceUsd,
        quotedAt: now,
        frozen: true
      };
    }

    const feeBase = await this.computeFeeBase(obs.priceUsd, now);
    if (feeBase === null) {
      if (lastGood !== null) {
        this.log?.error("computed fee failed clamps; serving last good fee");
        return {
          feeBase: BigInt(lastGood),
          feeUsdTarget: this.cfg.feeTargetUsd,
          priceUsd: obs.priceUsd,
          quotedAt: now,
          frozen: true
        };
      }
      throw new SubmissionsPausedError("fee failed sanity clamps and no prior fee");
    }

    return {
      feeBase,
      feeUsdTarget: this.cfg.feeTargetUsd,
      priceUsd: obs.priceUsd,
      quotedAt: now,
      frozen: false
    };
  }

  /**
   * Whole tokens ≈ FEE_TARGET_USD / price, clamped: never zero, never
   * negative, never more than maxFeeMultiple × the median-price fee.
   */
  private async computeFeeBase(priceUsd: number, now: number): Promise<bigint | null> {
    const whole = Math.round(this.cfg.feeTargetUsd / priceUsd);
    if (!Number.isFinite(whole) || whole < 1) return null;

    const median = await this.medianPrice(now);
    if (median !== null) {
      const medianFee = Math.max(1, Math.round(this.cfg.feeTargetUsd / median));
      if (whole > medianFee * (this.cfg.maxFeeMultiple ?? 10)) return null;
    }
    return wholeTokensToBase(BigInt(whole), this.cfg.tokenDecimals);
  }

  private async medianPrice(now: number): Promise<number | null> {
    const windowMs = this.cfg.medianWindowMs ?? 24 * 3600_000;
    const rows = await this.db.rows<{ price_usd: number }>(
      "SELECT price_usd FROM price_ticks WHERE observed_at >= $1 ORDER BY price_usd",
      [now - windowMs]
    );
    // Too few ticks to call anything an outlier — happens on first boot.
    if (rows.length < 5) return null;
    const mid = Math.floor(rows.length / 2);
    return rows.length % 2
      ? rows[mid].price_usd
      : (rows[mid - 1].price_usd + rows[mid].price_usd) / 2;
  }
}
