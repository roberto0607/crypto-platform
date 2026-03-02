import type { PoolClient } from "pg";
import { pool } from "../db/pool";
import type { OutboxEventRow, OutboxInsertInput } from "./outboxTypes";
import { outboxEventsTotal } from "../metrics";

/** Insert outbox event INSIDE a caller-managed transaction. */
export async function insertOutboxEventTx(
  client: PoolClient,
  input: OutboxInsertInput,
): Promise<void> {
  await client.query(
    `INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload)
     VALUES ($1, $2, $3, $4)`,
    [input.event_type, input.aggregate_type, input.aggregate_id ?? null, JSON.stringify(input.payload)],
  );
  outboxEventsTotal.inc({ event_type: input.event_type });
}

/**
 * Fetch next batch of events ready for processing.
 * Uses FOR UPDATE SKIP LOCKED for safe concurrent access.
 */
export async function fetchNextBatch(limit: number): Promise<OutboxEventRow[]> {
  const { rows } = await pool.query<OutboxEventRow>(
    `UPDATE outbox_events
     SET status = 'PROCESSING'
     WHERE id IN (
       SELECT id FROM outbox_events
       WHERE status IN ('PENDING', 'FAILED')
         AND next_attempt_at <= now()
       ORDER BY created_at ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING
       id::text, event_type, aggregate_type,
       aggregate_id::text, payload, status,
       attempts, last_error,
       next_attempt_at::text, created_at::text,
       processed_at::text`,
    [limit],
  );
  return rows;
}

/** Mark as DONE with processed_at = now(). */
export async function markDone(id: string): Promise<void> {
  await pool.query(
    `UPDATE outbox_events
     SET status = 'DONE', processed_at = now()
     WHERE id = $1`,
    [id],
  );
}

/** Mark as FAILED, increment attempts, set next_attempt_at with backoff. */
export async function markFailed(
  id: string,
  error: string,
  nextAttemptAt: Date,
): Promise<void> {
  await pool.query(
    `UPDATE outbox_events
     SET status = 'FAILED',
         attempts = attempts + 1,
         last_error = $2,
         next_attempt_at = $3
     WHERE id = $1`,
    [id, error, nextAttemptAt],
  );
}

/** Reset stuck PROCESSING rows older than timeoutMs back to PENDING. */
export async function resetStuckProcessing(timeoutMs: number): Promise<number> {
  const { rowCount } = await pool.query(
    `UPDATE outbox_events
     SET status = 'PENDING'
     WHERE status = 'PROCESSING'
       AND created_at < now() - ($1 || ' milliseconds')::interval`,
    [timeoutMs],
  );
  return rowCount ?? 0;
}

/** Count events by status (for admin stats endpoint). */
export async function countByStatus(): Promise<Record<string, number>> {
  const { rows } = await pool.query<{ status: string; count: string }>(
    `SELECT status, COUNT(*)::text AS count
     FROM outbox_events
     GROUP BY status`,
  );
  const result: Record<string, number> = {
    PENDING: 0,
    PROCESSING: 0,
    DONE: 0,
    FAILED: 0,
  };
  for (const row of rows) {
    result[row.status] = parseInt(row.count, 10);
  }
  return result;
}

/** List events with optional status filter (for admin list endpoint). */
export async function listEvents(
  status: string | undefined,
  limit: number,
): Promise<OutboxEventRow[]> {
  if (status) {
    const { rows } = await pool.query<OutboxEventRow>(
      `SELECT id::text, event_type, aggregate_type,
              aggregate_id::text, payload, status,
              attempts, last_error,
              next_attempt_at::text, created_at::text,
              processed_at::text
       FROM outbox_events
       WHERE status = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [status, limit],
    );
    return rows;
  }

  const { rows } = await pool.query<OutboxEventRow>(
    `SELECT id::text, event_type, aggregate_type,
            aggregate_id::text, payload, status,
            attempts, last_error,
            next_attempt_at::text, created_at::text,
            processed_at::text
     FROM outbox_events
     ORDER BY created_at DESC
     LIMIT $1`,
    [limit],
  );
  return rows;
}

/** Reset a FAILED event to PENDING for retry. */
export async function resetForRetry(id: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE outbox_events
     SET status = 'PENDING', next_attempt_at = now()
     WHERE id = $1 AND status = 'FAILED'`,
    [id],
  );
  return (rowCount ?? 0) > 0;
}
