/**
 * migrate.ts — SQL Migration Runner
 *
 * Forward-only migration system that applies .sql files from the migrations/
 * directory in alphabetical order. Each migration runs inside a transaction
 * so a failure rolls back cleanly without leaving the schema in a partial state.
 * An advisory lock prevents concurrent migration runs.
 *
 * How it works:
 *   1. Ensures the schema_migrations tracking table exists
 *   2. Acquires pg_advisory_lock to block concurrent runs
 *   3. Reads which migrations have already been applied
 *   4. Scans migrations/ for .sql files, sorted alphabetically (001_, 002_, …)
 *   5. Applies each unapplied file inside a BEGIN/COMMIT transaction
 *   6. Records the filename in schema_migrations as the migration ID
 *   7. Releases advisory lock, drains the connection pool and exits
 *
 * Usage: pnpm migrate (runs this file via tsx)
 */

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { pool } from "./pool";
import { acquireMigrationLock } from "./migrationGuard";

// Resolve from cwd so the script works when run from apps/api/.
const MIGRATIONS_DIR = path.join(process.cwd(), "migrations");

// Bootstrap: create the tracking table if this is a fresh database.
async function ensureMigrationsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

// Return the set of migration filenames that have already been applied.
async function getAppliedMigrations(): Promise<Set<string>> {
    const res = await pool.query<{ id: string }>(
        "SELECT id FROM schema_migrations;"
    );
    return new Set(res.rows.map((r) => r.id));
}

// Read all .sql files and sort alphabetically so they run in order.
function getMigrationFiles(): string[] {
    return fs
        .readdirSync(MIGRATIONS_DIR)
        .filter((f) => f.endsWith(".sql"))
        .sort();
}

// Run a single migration inside a transaction. If any statement fails,
// the entire migration is rolled back and the error propagates to main().
async function applyMigration(id: string, sql: string) {
    const client = await pool.connect();   // 👈 Acquire single connection

    try {
        await client.query("BEGIN");

        await client.query(sql);

        // Record this migration as applied so it won't run again.
        await client.query(
            "INSERT INTO schema_migrations (id) VALUES ($1)",
            [id]
        );

        await client.query("COMMIT");

        console.log(`Applied ${id}`);
    } catch (err) {
        await client.query("ROLLBACK");
        throw err;
    } finally {
        client.release();  // 👈 VERY IMPORTANT
    }
}


async function main() {
    await ensureMigrationsTable();

    const releaseLock = await acquireMigrationLock(pool);

    try {
        const applied = await getAppliedMigrations();
        const files = getMigrationFiles();

        for (const file of files) {
            // Skip migrations that have already been applied.
            if (applied.has(file)) continue;

            const fullPath = path.join(MIGRATIONS_DIR, file);
            const sql = fs.readFileSync(fullPath, "utf8");

            await applyMigration(file, sql);
        }
    } finally {
        releaseLock();
        // Drain all connections so the process can exit cleanly.
        await pool.end();
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});