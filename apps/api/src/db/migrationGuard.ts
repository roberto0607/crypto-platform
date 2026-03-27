/**
 * migrationGuard.ts — Startup migration version guard + advisory lock helper.
 *
 * runMigrationGuard(pool) — call before buildApp() in server.ts.
 *   Compares latest .sql file in migrations/ against latest row in schema_migrations.
 *   Exits process(1) on mismatch.
 *
 * acquireMigrationLock(pool) — call at start of migrate.ts main().
 *   Acquires pg_advisory_lock to prevent concurrent migration runs.
 *   Returns a release() function; call in finally block.
 */

import fs from "node:fs";
import path from "node:path";
import type { Pool } from "pg";
import { migrationGuardFailuresTotal } from "../metrics";

const MIGRATIONS_DIR = path.join(process.cwd(), "migrations");

// Stable integer key for the advisory lock — never changes.
const ADVISORY_LOCK_KEY = 1_234_567_890;

export type MigrationStatus = "IN_SYNC" | "DB_BEHIND" | "DB_AHEAD" | "DB_EMPTY";

export interface MigrationStatusResult {
  status: MigrationStatus;
  latestCodeVersion: string;
  dbVersion: string | null;
}

/** Returns the last .sql filename in migrations/ (alphabetically). */
export function getLatestCodeVersion(): string {
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  if (files.length === 0) {
    throw new Error("No migration files found in migrations/");
  }
  return files[files.length - 1];
}

/** Returns the latest migration id from schema_migrations, or null if table is empty. */
export async function getDbVersion(pool: Pool): Promise<string | null> {
  try {
    const res = await pool.query<{ id: string }>(
      "SELECT id FROM schema_migrations ORDER BY id DESC LIMIT 1;"
    );
    return res.rows[0]?.id ?? null;
  } catch {
    return null;
  }
}

/** Compare code vs DB and return a status result. */
export async function checkMigrationStatus(pool: Pool): Promise<MigrationStatusResult> {
  const latestCodeVersion = getLatestCodeVersion();
  const dbVersion = await getDbVersion(pool);

  let status: MigrationStatus;
  if (dbVersion === null) {
    status = "DB_EMPTY";
  } else if (dbVersion === latestCodeVersion) {
    status = "IN_SYNC";
  } else if (dbVersion < latestCodeVersion) {
    status = "DB_BEHIND";
  } else {
    status = "DB_AHEAD";
  }

  return { status, latestCodeVersion, dbVersion };
}

/**
 * Startup guard. Call before buildApp().
 * Exits process with code 1 if DB is not in sync with code migrations.
 */
export async function runMigrationGuard(pool: Pool): Promise<void> {
  const result = await checkMigrationStatus(pool);

  if (result.status === "IN_SYNC" || result.status === "DB_EMPTY") {
    console.log(
      `[migrationGuard] Schema OK — code=${result.latestCodeVersion} db=${result.dbVersion ?? "(empty)"}`
    );
    return;
  }

  migrationGuardFailuresTotal.inc();

  if (result.status === "DB_BEHIND") {
    const msg = `[migrationGuard] FATAL: DB is behind code. Run 'pnpm migrate'. ` +
        `code=${result.latestCodeVersion} db=${result.dbVersion}`;
    console.error(msg);
    throw new Error(msg);
  } else {
    const msg = `[migrationGuard] FATAL: DB is AHEAD of code — unexpected. ` +
        `code=${result.latestCodeVersion} db=${result.dbVersion}`;
    console.error(msg);
    throw new Error(msg);
  }
}

/**
 * Acquire a PostgreSQL session-level advisory lock before running migrations.
 * Prevents two concurrent `pnpm migrate` runs from racing.
 * Returns a release() function — call it in a finally block.
 */
export async function acquireMigrationLock(pool: Pool): Promise<() => void> {
  const client = await pool.connect();
  await client.query(`SELECT pg_advisory_lock(${ADVISORY_LOCK_KEY});`);
  console.log("[migrationGuard] Advisory migration lock acquired.");

  return function release() {
    client
      .query(`SELECT pg_advisory_unlock(${ADVISORY_LOCK_KEY});`)
      .finally(() => client.release());
  };
}
