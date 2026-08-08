import { Pool, types, type PoolClient } from "pg";

/**
 * int8 comes back from pg as a string to avoid precision loss. Every bigint
 * column here is a millisecond timestamp or a small counter, all far inside
 * Number.MAX_SAFE_INTEGER. Token amounts are the values that genuinely need
 * arbitrary precision, and those are stored as text and never parsed here.
 */
types.setTypeParser(types.builtins.INT8, (v) => Number(v));

export interface DB {
  rows<T>(sql: string, params?: unknown[]): Promise<T[]>;
  row<T>(sql: string, params?: unknown[]): Promise<T | null>;
  /** Returns the number of rows affected. */
  run(sql: string, params?: unknown[]): Promise<number>;
  tx<T>(fn: (db: DB) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

const SCHEMA = `
CREATE TABLE proposals (
  id          text PRIMARY KEY,
  title       text NOT NULL,
  amount_gbp  double precision NOT NULL,
  body        text NOT NULL,
  created_at  bigint NOT NULL
);

CREATE TABLE dockets (
  id                 text PRIMARY KEY,
  proposal_id        text NOT NULL REFERENCES proposals(id),
  deposit_address    text NOT NULL,
  derivation_index   integer NOT NULL,
  fee_tokens         text NOT NULL,          -- base units, never a float
  fee_usd_target     double precision NOT NULL,
  price_usd_at_quote double precision NOT NULL,
  quoted_at          bigint NOT NULL,
  paid_at            bigint,
  paid_tx            text,
  swept_at           bigint,
  judge_attempts     integer NOT NULL DEFAULT 0,
  status             text NOT NULL           -- awaiting_payment|paid|expired|judged
);
CREATE INDEX dockets_status ON dockets(status);

CREATE TABLE rulings (
  docket_id     text PRIMARY KEY REFERENCES dockets(id),
  verdict       text NOT NULL,               -- approved|rejected|void
  award_gbp     double precision,
  ruling_line   text NOT NULL,
  ruling_text   text NOT NULL,
  flags         text NOT NULL DEFAULT '[]',
  gates_passed  integer,
  model         text NOT NULL,
  ruled_at      bigint NOT NULL,
  review_status text NOT NULL,               -- auto|pending_review|confirmed
  post_status   text NOT NULL DEFAULT 'unposted',
  post_id       text,
  cycle         integer
);
CREATE INDEX rulings_ruled_at ON rulings(ruled_at);
CREATE INDEX rulings_cycle ON rulings(cycle, verdict);

CREATE TABLE claims (
  code           text PRIMARY KEY,
  verdict_id     text NOT NULL REFERENCES rulings(docket_id),
  award_gbp      double precision NOT NULL,
  award_tokens   text NOT NULL,              -- locked at ruling time
  expires_at     bigint NOT NULL,
  claimed_at     bigint,
  payout_address text,
  payout_tx      text,
  status         text NOT NULL               -- open|claimed|paid|expired
);
CREATE INDEX claims_verdict ON claims(verdict_id);

CREATE TABLE price_ticks (
  observed_at   bigint PRIMARY KEY,
  price_usd     double precision NOT NULL,
  liquidity_usd double precision NOT NULL,
  source        text NOT NULL
);

CREATE TABLE spend_log (
  day          text PRIMARY KEY,
  api_cost_usd double precision NOT NULL,
  calls        integer NOT NULL
);

CREATE TABLE kv (
  key   text PRIMARY KEY,
  value text NOT NULL
);

CREATE TABLE free_indexes (
  idx integer PRIMARY KEY
);

CREATE SEQUENCE docket_seq START 1;
CREATE SEQUENCE derivation_seq START 0 MINVALUE 0;
`;

const MIGRATIONS: string[] = [
  SCHEMA,
  // X posting is pay-per-use and needs its own ceiling, kept alongside model
  // spend so the running cost can be published in one place.
  `ALTER TABLE spend_log
     ADD COLUMN x_cost_usd double precision NOT NULL DEFAULT 0,
     ADD COLUMN x_posts integer NOT NULL DEFAULT 0;`,
  // Every figure the site quotes moved to dollars. These columns were named
  // for pounds and now hold dollars, so rename rather than leave the schema
  // lying about its contents. Values carry over unchanged: the amounts were
  // only ever notional and no payout has been made.
  `ALTER TABLE proposals RENAME COLUMN amount_gbp TO amount_usd;
   ALTER TABLE rulings   RENAME COLUMN award_gbp  TO award_usd;
   ALTER TABLE claims    RENAME COLUMN award_gbp  TO award_usd;`,
  // The claim code was returned by the public docket endpoint, and docket
  // ids are sequential, so anyone could walk D-1..D-n, lift the code for an
  // approved ruling and redirect the award to their own wallet. The code is
  // now released only to the holder of this token, which is handed out once
  // in the submission response and stored nowhere else.
  `ALTER TABLE dockets ADD COLUMN view_token text;`
];

function isLocal(connectionString: string): boolean {
  return /@(localhost|127\.0\.0\.1)[:/]/.test(connectionString);
}

export interface OpenOptions {
  /** Confines every table to one schema. Used to isolate tests. */
  schema?: string;
}

export async function openDb(connectionString: string, opts: OpenOptions = {}): Promise<DB> {
  // Heroku Postgres presents a certificate that is not in the default trust
  // store. Local development has no TLS at all.
  const ssl = isLocal(connectionString) ? false : { rejectUnauthorized: false };

  if (opts.schema) {
    if (!/^[a-z_][a-z0-9_]*$/.test(opts.schema)) throw new Error("bad schema name");
    const setup = new Pool({ connectionString, ssl, max: 1 });
    try {
      await setup.query(`CREATE SCHEMA IF NOT EXISTS ${opts.schema}`);
    } finally {
      await setup.end();
    }
  }

  const pool = new Pool({
    connectionString,
    max: 5,
    ssl,
    // Set as a connection parameter rather than a post-connect statement: a
    // fire-and-forget `SET search_path` races the first query on that client.
    ...(opts.schema ? { options: `-c search_path=${opts.schema}` } : {})
  });

  const db = wrap(pool, opts.schema);
  await migrate(db);
  return db;
}

function wrap(pool: Pool, schema?: string): DB {
  const exec = async (sql: string, params: unknown[] = []) => pool.query(sql, params);
  return {
    async rows<T>(sql: string, params?: unknown[]): Promise<T[]> {
      return (await exec(sql, params)).rows as T[];
    },
    async row<T>(sql: string, params?: unknown[]): Promise<T | null> {
      return ((await exec(sql, params)).rows[0] as T) ?? null;
    },
    async run(sql: string, params?: unknown[]): Promise<number> {
      return (await exec(sql, params)).rowCount ?? 0;
    },
    async tx<T>(fn: (db: DB) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        if (schema) await client.query(`SET search_path TO ${schema}`);
        await client.query("BEGIN");
        const out = await fn(bindClient(client));
        await client.query("COMMIT");
        return out;
      } catch (e) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw e;
      } finally {
        client.release();
      }
    },
    async close(): Promise<void> {
      await pool.end();
    }
  };
}

function bindClient(client: PoolClient): DB {
  return {
    async rows<T>(sql: string, params?: unknown[]): Promise<T[]> {
      return (await client.query(sql, params)).rows as T[];
    },
    async row<T>(sql: string, params?: unknown[]): Promise<T | null> {
      return ((await client.query(sql, params)).rows[0] as T) ?? null;
    },
    async run(sql: string, params?: unknown[]): Promise<number> {
      return (await client.query(sql, params)).rowCount ?? 0;
    },
    async tx<T>(fn: (db: DB) => Promise<T>): Promise<T> {
      return fn(bindClient(client)); // already inside a transaction
    },
    async close(): Promise<void> {
      /* the pool owns the client */
    }
  };
}

async function migrate(db: DB): Promise<void> {
  await db.run(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())"
  );
  await db.tx(async (tx) => {
    // Two dynos booting together must not both try to create the schema.
    await tx.run("SELECT pg_advisory_xact_lock($1)", [727_1987]);
    const done = new Set(
      (await tx.rows<{ version: number }>("SELECT version FROM schema_migrations")).map(
        (r) => r.version
      )
    );
    for (let i = 0; i < MIGRATIONS.length; i++) {
      if (done.has(i)) continue;
      await tx.run(MIGRATIONS[i]);
      await tx.run("INSERT INTO schema_migrations (version) VALUES ($1)", [i]);
    }
  });
}

export async function kvGet(db: DB, key: string): Promise<string | null> {
  const row = await db.row<{ value: string }>("SELECT value FROM kv WHERE key = $1", [key]);
  return row?.value ?? null;
}

export async function kvSet(db: DB, key: string, value: string): Promise<void> {
  await db.run(
    "INSERT INTO kv (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    [key, value]
  );
}

/** Next docket number, monotonic, starting at 1. */
export async function nextDocketNumber(db: DB): Promise<number> {
  const row = await db.row<{ n: number }>("SELECT nextval('docket_seq') AS n");
  return Number(row!.n);
}

/**
 * Lowest freed derivation index, else the next fresh one. The delete and the
 * read are one statement, so two callers cannot take the same freed index.
 */
export async function allocateDerivationIndex(db: DB): Promise<number> {
  const reused = await db.row<{ idx: number }>(
    `DELETE FROM free_indexes WHERE idx = (SELECT MIN(idx) FROM free_indexes) RETURNING idx`
  );
  if (reused) return reused.idx;
  const row = await db.row<{ n: number }>("SELECT nextval('derivation_seq') AS n");
  return Number(row!.n);
}

export async function freeDerivationIndex(db: DB, idx: number): Promise<void> {
  await db.run("INSERT INTO free_indexes (idx) VALUES ($1) ON CONFLICT DO NOTHING", [idx]);
}
