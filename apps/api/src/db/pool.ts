/**
 * pool.ts — PostgreSQL Connection Pool (Singleton)
 *
 * Creates and exports a single pg.Pool instance shared by the entire API.
 * The pool is created at import time (module-level side effect), so every
 * module that imports `pool` shares the same set of connections.
 *
 * SECURITY: The hardcoded fallback connection string contains plaintext
 * credentials. This is acceptable for local development only. In production,
 * always set the database URL via environment variables or a secrets manager.
 */

import { Pool } from "pg";

// Falls back to the local Docker Compose database when the env var is unset.
const connectionString =
    process.env.DATABASE_URL ?? "postgresql://cp:cp@localhost:5433/cp";

export const pool = new Pool({
    connectionString,
    max: 10,              // max concurrent clients — tune for production concurrency
    idleTimeoutMillis: 30_000,  // release idle clients after 30s to free PG slots
});

// Catch unexpected backend disconnections (e.g. PG restart) so they surface
// as logged errors instead of crashing the process as unhandled exceptions.
pool.on("error", (err) => {
    console.error("Unexpected PostgreSQL pool error:", err);
})