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
 * Usage: pnpm migrate          (runs this file via tsx)
 *        runPendingMigrations() (called at boot when RUN_MIGRATIONS_ON_BOOT=true)
 */

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import type { Pool } from "pg";
import { pool as defaultPool } from "./pool";
import { acquireMigrationLock } from "./migrationGuard";

// Resolve from cwd so the script works when run from apps/api/.
const MIGRATIONS_DIR = path.join(process.cwd(), "migrations");

// Bootstrap: create the tracking table if this is a fresh database.
async function ensureMigrationsTable(p: Pool) {
  await p.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

// Return the set of migration filenames that have already been applied.
async function getAppliedMigrations(p: Pool): Promise<Set<string>> {
    const res = await p.query<{ id: string }>(
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
// the entire migration is rolled back and the error propagates.
async function applyMigration(p: Pool, id: string, sql: string) {
    const client = await p.connect();   // 👈 Acquire single connection

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

/**
 * Run all pending migrations with an advisory lock.
 * Safe to call from server.ts at boot — does NOT drain pool or exit.
 */
export async function runPendingMigrations(p: Pool): Promise<void> {
    await ensureMigrationsTable(p);

    const releaseLock = await acquireMigrationLock(p);

    try {
        const applied = await getAppliedMigrations(p);
        const files = getMigrationFiles();

        for (const file of files) {
            if (applied.has(file)) continue;

            const fullPath = path.join(MIGRATIONS_DIR, file);
            const sql = fs.readFileSync(fullPath, "utf8");

            await applyMigration(p, file, sql);
        }
    } finally {
        releaseLock();
    }
}


async function main() {
    await runPendingMigrations(defaultPool);

    // Drain all connections so the process can exit cleanly.
    await defaultPool.end();
}

// Only run main() when executed directly (not imported)
const isDirectRun = process.argv[1]?.endsWith("migrate.ts") ||
                    process.argv[1]?.endsWith("migrate.js");
if (isDirectRun) {
    main().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
