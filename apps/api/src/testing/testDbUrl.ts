/**
 * testDbUrl.ts — resolve the database URL the test suite must use.
 *
 * Tests truncate application tables (see resetDb.ts), so they MUST run against
 * a dedicated *_test database — never the dev DB. Resolution order:
 *
 *   1. TEST_DATABASE_URL, if set, always wins (explicit override).
 *   2. If DATABASE_URL already points at a *_test database (e.g. CI provisions
 *      one), keep it.
 *   3. Otherwise (local dev, where .env points at cp) force the local cp_test DB.
 *
 * IMPORTANT: this module must not import pool.ts/config.ts — it is loaded from
 * vitest setupFiles BEFORE the pool reads DATABASE_URL, so it has to stay free
 * of any side effect that would open a connection.
 */

export const LOCAL_TEST_DATABASE_URL = "postgresql://cp:cp@localhost:5435/cp_test";

/** True when the connection string targets a database whose name ends in `_test`. */
export function isTestDatabaseUrl(url: string): boolean {
  // Match `_test` at the end of the path, optionally followed by a query string.
  return /_test(\?|$)/.test(url);
}

export function resolveTestDatabaseUrl(): string {
  if (process.env.TEST_DATABASE_URL) return process.env.TEST_DATABASE_URL;
  const current = process.env.DATABASE_URL ?? "";
  if (isTestDatabaseUrl(current)) return current;
  return LOCAL_TEST_DATABASE_URL;
}
