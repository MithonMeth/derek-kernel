import { Pool } from "pg";

// This project only ever talks to a remote managed Postgres (Heroku Postgres
// today), which requires SSL regardless of NODE_ENV — never a local unencrypted
// one. Heroku's cert chain isn't trusted by Node's default CA bundle, so
// disabling strict verification (not encryption itself) is Heroku's own
// documented pattern for connecting from `pg`. See
// https://devcenter.heroku.com/articles/heroku-postgresql#connecting-in-node-js
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

export function query<T extends Record<string, unknown> = Record<string, unknown>>(
  text: string,
  params?: unknown[],
) {
  return pool.query<T>(text, params);
}
