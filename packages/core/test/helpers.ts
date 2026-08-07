import { randomBytes } from "node:crypto";
import { openDb, type DB } from "../src/db.js";

/**
 * Tests run against a real Postgres rather than an in-memory stand-in, so
 * dialect differences and constraint behaviour are exercised for real.
 * Start one with:
 *
 *   docker run -d --name derek-pg -e POSTGRES_PASSWORD=derek \
 *     -e POSTGRES_USER=derek -e POSTGRES_DB=derek -p 55432:5432 postgres:16-alpine
 */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://derek:derek@localhost:55432/derek";

const open: DB[] = [];

/** A private schema per call, so tests are isolated and can run in parallel. */
export async function testDb(): Promise<DB> {
  const db = await openDb(TEST_DATABASE_URL, {
    schema: "t_" + randomBytes(8).toString("hex")
  });
  open.push(db);
  return db;
}

export async function closeTestDbs(): Promise<void> {
  await Promise.all(open.splice(0).map((db) => db.close().catch(() => undefined)));
}
