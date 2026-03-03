/**
 * dbTiming.ts — DB query timing instrumentation.
 *
 * Wraps pool.query / client.query with duration tracking,
 * Prometheus metrics, and slow-query warnings.
 */

import type { QueryResult, QueryResultRow } from "pg";
import { performance } from "node:perf_hooks";
import { config } from "../config";
import { dbQueryTotal, dbQueryDurationMs } from "../metrics";
import { logger } from "./logContext";

/** Anything that has a .query() method — Pool or PoolClient. */
interface Queryable {
  query<T extends QueryResultRow = any>(
    sql: string,
    params?: unknown[],
  ): Promise<QueryResult<T>>;
}

/**
 * Execute a named, timed DB query.
 *
 * @param client   - Pool or PoolClient
 * @param name     - Stable operation name (e.g. "walletRepo.lockWalletsForUpdate")
 * @param sql      - SQL string
 * @param params   - Bind parameters
 * @param requestId - Optional correlation ID for log context
 */
export async function timedQuery<T extends QueryResultRow = any>(
  client: Queryable,
  name: string,
  sql: string,
  params?: unknown[],
  requestId?: string,
): Promise<QueryResult<T>> {
  const start = performance.now();
  try {
    const result = await client.query<T>(sql, params);
    return result;
  } finally {
    const durationMs = performance.now() - start;
    dbQueryTotal.inc({ name });
    dbQueryDurationMs.observe({ name }, durationMs);

    if (durationMs > config.dbSlowQueryMs) {
      const logPayload: Record<string, unknown> = {
        eventType: "db.slow_query",
        name,
        durationMs: Math.round(durationMs * 100) / 100,
      };
      if (requestId) logPayload.requestId = requestId;
      if (config.dbLogSqlOnSlow) logPayload.sql = sql;
      logger.warn(logPayload, `Slow query: ${name} (${durationMs.toFixed(1)}ms)`);
    }
  }
}
