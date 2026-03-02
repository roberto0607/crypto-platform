import { config } from "../config";
import { logger } from "../observability/logContext";
import { fetchNextBatch, markDone, markFailed, resetStuckProcessing } from "./outboxRepo";
import { processEvent } from "./outboxProcessor";
import {
  outboxProcessedTotal,
  outboxFailuresTotal,
  outboxRetriesTotal,
  outboxProcessingDurationMs,
  outboxQueueDepth,
} from "../metrics";

/**
 * Process one batch of outbox events.
 * Exported for admin replay endpoint.
 */
export async function processBatch(): Promise<number> {
  const resetCount = await resetStuckProcessing(config.outboxProcessingTimeoutMs);
  if (resetCount > 0) {
    logger.info({ resetCount }, "Outbox: reset stuck PROCESSING rows");
  }

  const rows = await fetchNextBatch(config.outboxBatchSize);
  outboxQueueDepth.set(rows.length);

  if (rows.length === 0) return 0;

  let processed = 0;

  for (const row of rows) {
    const startMs = performance.now();
    try {
      await processEvent(row);
      await markDone(row.id);
      outboxProcessedTotal.inc({ event_type: row.event_type });
      processed++;
    } catch (err: unknown) {
      const attempts = row.attempts + 1;
      const backoffSec = Math.min(Math.pow(2, attempts), 300);
      const nextAttemptAt = new Date(Date.now() + backoffSec * 1000);
      const errorMsg = err instanceof Error ? err.message : String(err);

      await markFailed(row.id, errorMsg, nextAttemptAt);
      outboxFailuresTotal.inc({ event_type: row.event_type });
      outboxRetriesTotal.inc({ event_type: row.event_type });

      logger.warn(
        { outboxId: row.id, event_type: row.event_type, attempts, backoffSec, error: errorMsg },
        "Outbox event processing failed",
      );
    } finally {
      outboxProcessingDurationMs.observe(
        { event_type: row.event_type },
        performance.now() - startMs,
      );
    }
  }

  return processed;
}

/**
 * Start the outbox polling worker.
 * Returns a stop() function to clear the interval.
 */
export function startOutboxWorker(): { stop: () => void } {
  logger.info(
    { pollIntervalMs: config.outboxPollIntervalMs, batchSize: config.outboxBatchSize },
    "Outbox worker started",
  );

  const intervalId = setInterval(async () => {
    try {
      await processBatch();
    } catch (err) {
      logger.error({ err }, "Outbox worker tick failed");
    }
  }, config.outboxPollIntervalMs);

  return {
    stop: () => {
      clearInterval(intervalId);
      logger.info("Outbox worker stopped");
    },
  };
}
