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

import { Pool, type PoolClient } from "pg";
import { performance } from "node:perf_hooks";
import { requireEnv, config } from "../config";
import { dbPoolAcquireDurationMs } from "../metrics";
import pino from "pino";

const poolLogger = pino({ level: process.env.LOG_LEVEL ?? "info" });

const connectionString = requireEnv("DATABASE_URL");
const isRemote = !connectionString.includes("localhost") && !connectionString.includes("127.0.0.1");

export const pool = new Pool({
    connectionString,
    max: config.dbPoolMax, // env DB_POOL_MAX, default 20
    idleTimeoutMillis: 30_000,  // release idle clients after 30s to free PG slots
    ...(isRemote && { ssl: { rejectUnauthorized: false } }),
});

// Catch unexpected backend disconnections (e.g. PG restart) so they surface
// as logged errors instead of crashing the process as unhandled exceptions.
pool.on("error", (err) => {
    poolLogger.error({ eventType: "pg.pool_error", err }, "Unexpected PostgreSQL pool error");
});

/**
 * Acquire a client from the pool with acquire-latency tracking.
 * Use this instead of pool.connect() in transaction code paths.
 */
export async function acquireClient(): Promise<PoolClient> {
    const start = performance.now();
    const client = await pool.connect();
    dbPoolAcquireDurationMs.observe(performance.now() - start);
    return client;
}
