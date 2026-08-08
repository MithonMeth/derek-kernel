import { z } from "zod";

const bool = z
  .string()
  .transform((v) => v === "true" || v === "1")
  .pipe(z.boolean());

const num = z.string().transform(Number).pipe(z.number().finite());

const EnvSchema = z.object({
  ANTHROPIC_API_KEY: z.string().optional(),
  TOKEN_MINT_ADDRESS: z.string().optional(),
  TREASURY_ADDRESS: z.string().optional(),
  BURN_ADDRESS: z.string().optional(),
  /** Receives the airdrop share of every fee. A wallet of its own. */
  AIRDROP_ADDRESS: z.string().optional(),
  DEPOSIT_MASTER_SEED: z
    .string()
    .regex(/^[0-9a-fA-F]{64,128}$/, "hex seed, 64-128 chars")
    .optional(),
  /** Base58 secret key that pays sweep network fees and destination rent. */
  SWEEP_FEE_PAYER_SECRET: z.string().optional(),
  /** Balances at or below this are not worth a transaction. Whole tokens. */
  SWEEP_DUST_TOKENS: num.pipe(z.number().nonnegative()).default("1" as never),
  RPC_URL: z.string().url().optional(),
  DATABASE_URL: z.string().optional(),
  // OAuth 1.0a needs all four. Posting is pay-per-use since Feb 2026:
  // $0.015 a post, $0.20 if it contains a link — see the publisher.
  X_CONSUMER_KEY: z.string().optional(),
  X_CONSUMER_SECRET: z.string().optional(),
  X_ACCESS_TOKEN: z.string().optional(),
  X_ACCESS_SECRET: z.string().optional(),
  /** Numeric account id; only needed to reconcile after a failed post. */
  X_USER_ID: z.string().optional(),
  /** The fee in dollars. The token amount is derived from the live price. */
  FEE_TARGET_USD: num.pipe(z.number().positive()).default("2" as never),
  MIN_LIQUIDITY_USD: num.pipe(z.number().nonnegative()).default("15000" as never),
  MAX_DAILY_API_USD: num.pipe(z.number().nonnegative()).default("25" as never),
  /** X is pay-per-use at $0.015 a post; this stops a loop burning credits. */
  MAX_DAILY_X_USD: num.pipe(z.number().nonnegative()).default("5" as never),
  MAX_SUBMISSIONS_PER_HOUR: num.pipe(z.number().int().positive()).default("400" as never),
  CLAIM_EXPIRY_DAYS: num.pipe(z.number().int().positive()).default("7" as never),
  AUTO_APPROVE_UNFLAGGED: bool.default("false" as never),
  /**
   * Off by default: sweeping is the only thing here that moves money, and
   * it should not start doing so on a timer the moment a mint address
   * appears. Until this is on, fees accumulate in their deposit addresses
   * and `admin sweep --send` moves them when an operator decides to.
   */
  SWEEP_AUTO: bool.default("false" as never),
  PAUSED: bool.default("true" as never),
  TOKEN_DECIMALS: num.pipe(z.number().int().min(0).max(18)).default("9" as never),
  CHAIN_ID: z.string().default("solana"),
  FAKE_TREASURY_USD: num.pipe(z.number().nonnegative()).optional(),
  SITE_URL: z.string().default("https://www.derek-kernel.xyz"),
  EMBED_WORKER: bool.default("true" as never),
  PORT: num.pipe(z.number().int().positive()).default("3000" as never)
});

export type Config = z.infer<typeof EnvSchema>;

/** Format the deposit seed must satisfy to derive anything. */
const SEED_RE = /^[0-9a-fA-F]{64,128}$/;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const picked: Record<string, string> = {};
  for (const key of Object.keys(EnvSchema.shape)) {
    const v = env[key];
    // Trimmed because a value pasted into a shell or a dashboard field
    // arrives with a trailing newline far more often than anyone expects,
    // and no setting here wants surrounding whitespace.
    if (v !== undefined && v.trim() !== "") picked[key] = v.trim();
  }

  // A malformed deposit seed used to throw here, which crashed the process
  // before the HTTP server existed and took the whole public site down -
  // the ledger, the constitution, every ruling - over one optional secret.
  // Deposits are the only thing that actually depends on it, so a bad value
  // now disables deposits and says so, loudly, once.
  const seed = picked.DEPOSIT_MASTER_SEED;
  if (seed !== undefined && !SEED_RE.test(seed)) {
    delete picked.DEPOSIT_MASTER_SEED;
    console.error(
      `DEPOSIT_MASTER_SEED is not a ${64}-128 character hex string ` +
        `(got ${seed.length} characters` +
        (/\s/.test(seed) ? ", including whitespace - is it two values pasted together?" : "") +
        "). Deposits are disabled until it is fixed; nothing else is affected."
    );
  }

  return EnvSchema.parse(picked);
}
