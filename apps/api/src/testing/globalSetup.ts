/**
 * globalSetup.ts — vitest globalSetup entry (runs once, in the main process).
 *
 * Ensures the dedicated *_test database exists and is fully migrated before any
 * test worker connects. Idempotent: safe to run repeatedly.
 */
import { Client, Pool } from "pg";
import { resolveTestDatabaseUrl } from "./testDbUrl";

export default async function globalSetup(): Promise<void> {
  const url = resolveTestDatabaseUrl();
  const dbName = new URL(url).pathname.replace(/^\//, "");

  // Create the test database if missing. Connect to the maintenance DB on the
  // same server (CREATE DATABASE cannot run from inside the target database).
  const adminUrl = new URL(url);
  adminUrl.pathname = "/postgres";
  const admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    const { rowCount } = await admin.query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [dbName],
    );
    if (!rowCount) {
      // dbName is derived from our own resolved URL (not user input).
      await admin.query(`CREATE DATABASE "${dbName}"`);
    }
  } finally {
    await admin.end();
  }

  // Apply migrations to the test DB. Set DATABASE_URL first so the migrate
  // module's default pool (imported transitively) also targets cp_test.
  process.env.DATABASE_URL = url;
  const { runPendingMigrations } = await import("../db/migrate");
  const pool = new Pool({ connectionString: url });
  try {
    await runPendingMigrations(pool);
  } finally {
    await pool.end();
  }
}
