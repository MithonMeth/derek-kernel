import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type DB = Database.Database;

const MIGRATIONS: string[] = [
  `
  CREATE TABLE proposals (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    amount_gbp  REAL NOT NULL,
    body        TEXT NOT NULL,
    created_at  INTEGER NOT NULL
  );

  CREATE TABLE dockets (
    id               TEXT PRIMARY KEY,            -- 'D-1205'
    proposal_id      TEXT NOT NULL REFERENCES proposals(id),
    deposit_address  TEXT NOT NULL,
    derivation_index INTEGER NOT NULL,
    fee_tokens       TEXT NOT NULL,               -- base units, string, never a JS number
    fee_usd_target   REAL NOT NULL,
    price_usd_at_quote REAL NOT NULL,
    quoted_at        INTEGER NOT NULL,
    paid_at          INTEGER,
    paid_tx          TEXT,
    swept_at         INTEGER,
    judge_attempts   INTEGER NOT NULL DEFAULT 0,  -- failed pipeline runs; >=3 needs a human
    status           TEXT NOT NULL                -- awaiting_payment | paid | expired | judged
  );
  CREATE INDEX dockets_status ON dockets(status);

  CREATE TABLE rulings (
    docket_id     TEXT PRIMARY KEY REFERENCES dockets(id),
    verdict       TEXT NOT NULL,                  -- approved | rejected | void
    award_gbp     REAL,                           -- null unless approved
    ruling_line   TEXT NOT NULL,
    ruling_text   TEXT NOT NULL,
    flags         TEXT NOT NULL DEFAULT '[]',     -- JSON array of screening flags
    gates_passed  INTEGER,
    model         TEXT NOT NULL,
    ruled_at      INTEGER NOT NULL,
    review_status TEXT NOT NULL,                  -- auto | pending_review | confirmed
    post_status   TEXT NOT NULL DEFAULT 'unposted', -- unposted | posting | posted | queued_manual
    post_id       TEXT
  );
  CREATE INDEX rulings_ruled_at ON rulings(ruled_at);

  CREATE TABLE claims (
    code           TEXT PRIMARY KEY,              -- 32 hex chars, single use
    verdict_id     TEXT NOT NULL REFERENCES rulings(docket_id),
    award_gbp      REAL NOT NULL,
    award_tokens   TEXT NOT NULL,                 -- base units, locked at ruling time
    expires_at     INTEGER NOT NULL,
    claimed_at     INTEGER,
    payout_address TEXT,
    payout_tx      TEXT,
    status         TEXT NOT NULL                  -- open | claimed | paid | expired
  );

  CREATE TABLE price_ticks (
    observed_at   INTEGER PRIMARY KEY,
    price_usd     REAL NOT NULL,
    liquidity_usd REAL NOT NULL,
    source        TEXT NOT NULL
  );

  CREATE TABLE spend_log (
    day          TEXT PRIMARY KEY,                -- 'YYYY-MM-DD'
    api_cost_usd REAL NOT NULL,
    calls        INTEGER NOT NULL
  );

  CREATE TABLE kv (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE free_indexes (
    idx INTEGER PRIMARY KEY
  );
  `
];

export function openDb(path: string): DB {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

function migrate(db: DB): void {
  const version = db.pragma("user_version", { simple: true }) as number;
  for (let i = version; i < MIGRATIONS.length; i++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[i]);
      db.pragma(`user_version = ${i + 1}`);
    })();
  }
}

export function kvGet(db: DB, key: string): string | null {
  const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function kvSet(db: DB, key: string, value: string): void {
  db.prepare(
    "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(key, value);
}

/** Next docket number, monotonically increasing, starting at 1. */
export function nextDocketNumber(db: DB): number {
  let n = 0;
  db.transaction(() => {
    n = Number(kvGet(db, "docket_seq") ?? "0") + 1;
    kvSet(db, "docket_seq", String(n));
  })();
  return n;
}

/** Lowest freed derivation index, else the next fresh one. */
export function allocateDerivationIndex(db: DB): number {
  let idx = 0;
  db.transaction(() => {
    const freed = db
      .prepare("SELECT idx FROM free_indexes ORDER BY idx LIMIT 1")
      .get() as { idx: number } | undefined;
    if (freed) {
      db.prepare("DELETE FROM free_indexes WHERE idx = ?").run(freed.idx);
      idx = freed.idx;
      return;
    }
    idx = Number(kvGet(db, "derivation_seq") ?? "0");
    kvSet(db, "derivation_seq", String(idx + 1));
  })();
  return idx;
}

export function freeDerivationIndex(db: DB, idx: number): void {
  db.prepare("INSERT OR IGNORE INTO free_indexes (idx) VALUES (?)").run(idx);
}
