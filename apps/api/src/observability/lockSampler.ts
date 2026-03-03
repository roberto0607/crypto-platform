/**
 * lockSampler.ts — Periodic lock contention sampler.
 *
 * Polls pg_stat_activity + pg_locks on an interval to detect and report
 * lock contention. Emits Prometheus gauges and structured log summaries.
 *
 * Safe for production: does NOT log query text, only state, duration,
 * and relation names.
 */

import { pool } from "../db/pool";
import { config } from "../config";
import {
  pgLockWaitingTotal,
  pgLockWaitDurationMaxSeconds,
  pgLockedRelationWaits,
} from "../metrics";
import { logger } from "./logContext";

let timer: NodeJS.Timeout | null = null;

async function sampleLocks(): Promise<void> {
  // Query 1: Count active vs waiting queries + longest wait
  const activityResult = await pool.query<{
    active_queries: string;
    waiting_queries: string;
    max_wait_seconds: string | null;
  }>(`
    SELECT
      COUNT(*) FILTER (WHERE state = 'active') AS active_queries,
      COUNT(*) FILTER (WHERE wait_event_type = 'Lock') AS waiting_queries,
      EXTRACT(EPOCH FROM MAX(
        CASE WHEN wait_event_type = 'Lock'
             THEN now() - query_start
        END
      )) AS max_wait_seconds
    FROM pg_stat_activity
    WHERE pid != pg_backend_pid()
      AND datname = current_database()
  `);

  const row = activityResult.rows[0];
  const activeQueries = Number(row.active_queries);
  const waitingQueries = Number(row.waiting_queries);
  const maxWaitSeconds = Number(row.max_wait_seconds ?? 0);

  pgLockWaitingTotal.set(waitingQueries);
  pgLockWaitDurationMaxSeconds.set(maxWaitSeconds);

  // Query 2: Top-N locked relations (only when contention exists)
  if (waitingQueries > 0) {
    const lockedResult = await pool.query<{
      relname: string;
      wait_count: string;
    }>(`
      SELECT c.relname, COUNT(*) AS wait_count
      FROM pg_locks l
      JOIN pg_class c ON c.oid = l.relation
      WHERE NOT l.granted AND c.relname NOT LIKE 'pg_%'
      GROUP BY c.relname
      ORDER BY wait_count DESC
      LIMIT $1
    `, [config.lockSamplerTopN]);

    pgLockedRelationWaits.reset();
    for (const r of lockedResult.rows) {
      pgLockedRelationWaits.set({ relname: r.relname }, Number(r.wait_count));
    }

    logger.info({
      eventType: "lock.contention_detected",
      activeQueries,
      waitingQueries,
      maxWaitSeconds: Math.round(maxWaitSeconds * 1000) / 1000,
      topRelations: lockedResult.rows.map((r) => ({
        relname: r.relname,
        count: Number(r.wait_count),
      })),
    }, `Lock contention: ${waitingQueries} waiting queries`);
  }
}

export function startLockSampler(): void {
  if (!config.lockSamplerEnabled) return;
  timer = setInterval(() => {
    sampleLocks().catch((err) => {
      logger.error({ eventType: "lock.sampler_error", err }, "lockSampler error");
    });
  }, config.lockSamplerIntervalMs);
  timer.unref(); // Don't prevent process exit
  logger.info(
    { eventType: "lock.sampler_started", intervalMs: config.lockSamplerIntervalMs },
    "Lock sampler started",
  );
}

export function stopLockSampler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
