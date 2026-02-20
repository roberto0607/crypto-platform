/**
 * pool.ts — PostgreSQL Connection Pool (Singleton)
 *
 * Creates and exports a single pg.Pool instance shared by the entire API.
 * The pool is created at import time (module-level side effect), so every
 * module that imports `pool` shares the same set of connections.
 *
 * DATABASE_URL must be set in the environment (or .env). The process will
 * fail fast at startup if it is missing.
 */

import { Pool } from "pg";
import { requireEnv } from "../config";

const connectionString = requireEnv("DATABASE_URL");

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