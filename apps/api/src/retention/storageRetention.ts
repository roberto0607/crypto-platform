/**
 * storageRetention.ts — enforces the storage budget for append-only,
 * high-volume tables (candles, agent_run_logs, processed outbox rows).
 *
 * Budget (defaults; env-overridable via config.retention*):
 *   candles 1m   30 days     ← charts' 1m view + Kraken/agg mirror
 *   candles 5m   365 days    ← post-match replay reads 5m for a match window
 *   candles 15m  365 days
 *   candles 1h/4h/1d/1w      kept indefinitely (coarse, tiny)
 *   agent_run_logs           14 days
 *   outbox_events (DONE)     7 days  (PENDING/FAILED/PROCESSING never touched)
 *
 * Every delete goes through deleteInBatches (short transactions, paced,
 * capped per run) so a run can never lock a table or spike WAL; anything
 * left over when the cap hits is picked up by the next hourly run.
 *
 * Candle deletes are issued per (pair_id, timeframe) so each batch is a
 * range scan on candles_pkey (pair_id, timeframe, ts) instead of a
 * sequential scan. All pairs are swept, not just the MARKET_SYMBOLS ones,
 * so history left over from pairs that were once stored still ages out.
 */
import type { Pool } from "pg";
import type { Logger } from "pino";
import { config } from "../config";
import { deleteInBatches, type BatchDeleteOptions } from "./batchDelete";
import { retentionRowsDeletedTotal } from "../metrics";

export interface StorageBudget {
  /** timeframe → retention days. Timeframes not listed (or 0) are kept forever. */
  candleDays: Record<string, number>;
  agentRunLogDays: number;
  outboxDoneDays: number;
}

export function budgetFromConfig(): StorageBudget {
  return {
    candleDays: {
      "1m": config.retentionCandle1mDays,
      "5m": config.retentionCandle5mDays,
      "15m": config.retentionCandle15mDays,
    },
    agentRunLogDays: config.retentionAgentRunLogDays,
    outboxDoneDays: config.retentionOutboxDoneDays,
  };
}

export interface StorageRetentionResult {
  candlesDeleted: Record<string, number>;
  agentRunLogsDeleted: number;
  outboxDoneDeleted: number;
  /** false if any table hit the per-run batch cap (more left for next run). */
  complete: boolean;
  durationMs: number;
}

const MS_PER_DAY = 86_400_000;

export async function runStorageRetention(
  pool: Pool,
  logger: Logger,
  opts: { budget?: StorageBudget; batch?: BatchDeleteOptions; now?: number } = {},
): Promise<StorageRetentionResult> {
  const budget = opts.budget ?? budgetFromConfig();
  const batch = opts.batch ?? {};
  const now = opts.now ?? Date.now();
  const started = performance.now();
  const cutoff = (days: number) => new Date(now - days * MS_PER_DAY);

  let complete = true;
  const candlesDeleted: Record<string, number> = {};

  const { rows: pairs } = await pool.query<{ id: string }>(`SELECT id FROM trading_pairs`);
  for (const [tf, days] of Object.entries(budget.candleDays)) {
    if (!(days > 0)) continue;
    candlesDeleted[tf] = 0;
    for (const { id } of pairs) {
      const r = await deleteInBatches(
        pool,
        "candles",
        "pair_id = $1 AND timeframe = $2 AND ts < $3",
        [id, tf, cutoff(days)],
        batch,
      );
      candlesDeleted[tf] += r.deleted;
      complete &&= r.complete;
    }
    retentionRowsDeletedTotal.inc({ table: `candles_${tf}` }, candlesDeleted[tf]);
  }

  let agentRunLogsDeleted = 0;
  if (budget.agentRunLogDays > 0) {
    const r = await deleteInBatches(pool, "agent_run_logs", "created_at < $1", [cutoff(budget.agentRunLogDays)], batch);
    agentRunLogsDeleted = r.deleted;
    complete &&= r.complete;
    retentionRowsDeletedTotal.inc({ table: "agent_run_logs" }, agentRunLogsDeleted);
  }

  let outboxDoneDeleted = 0;
  if (budget.outboxDoneDays > 0) {
    const r = await deleteInBatches(
      pool,
      "outbox_events",
      "status = 'DONE' AND created_at < $1",
      [cutoff(budget.outboxDoneDays)],
      batch,
    );
    outboxDoneDeleted = r.deleted;
    complete &&= r.complete;
    retentionRowsDeletedTotal.inc({ table: "outbox_events" }, outboxDoneDeleted);
  }

  const result: StorageRetentionResult = {
    candlesDeleted,
    agentRunLogsDeleted,
    outboxDoneDeleted,
    complete,
    durationMs: Math.round(performance.now() - started),
  };
  logger.info({ result }, "storage_retention_complete");
  return result;
}
