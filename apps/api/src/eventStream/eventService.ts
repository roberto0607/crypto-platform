import type { PoolClient } from "pg";
import { pool } from "../db/pool";
import { logger } from "../observability/logContext";
import { computeEventHash } from "./eventHash";
import {
  getLatestEventHash,
  appendEventTx as repoAppendEventTx,
} from "./eventRepo";
import type { EventInput } from "./eventTypes";
import {
  eventStreamTotal,
  eventStreamVerifyRunsTotal,
  eventStreamVerifyFailuresTotal,
  eventStreamVerifyDurationMs,
} from "../metrics";

/**
 * Record an event inside a caller-managed transaction.
 * Returns the computed event_hash.
 */
export async function recordEventTx(
  client: PoolClient,
  input: EventInput,
): Promise<string> {
  // Serialize event appends to maintain hash chain integrity.
  // Released automatically when the transaction commits/rollbacks.
  await client.query(
    `SELECT pg_advisory_xact_lock(hashtext('event_stream_append'))`,
  );

  const previousHash = await getLatestEventHash(client);
  const createdAt = new Date();

  const eventHash = computeEventHash({
    event_type: input.eventType,
    entity_type: input.entityType,
    entity_id: input.entityId ?? null,
    actor_user_id: input.actorUserId ?? null,
    payload: input.payload,
    previous_event_hash: previousHash,
    created_at_iso: createdAt.toISOString(),
  });

  await repoAppendEventTx(client, {
    eventType: input.eventType,
    entityType: input.entityType,
    entityId: input.entityId,
    actorUserId: input.actorUserId,
    payload: input.payload,
    previousEventHash: previousHash,
    eventHash,
    createdAt,
  });

  eventStreamTotal.inc({ event_type: input.eventType });
  return eventHash;
}

/**
 * Record an event using its own transaction (convenience wrapper).
 */
export async function recordEvent(input: EventInput): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const hash = await recordEventTx(client, input);
    await client.query("COMMIT");
    return hash;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Verify the full chain from the first event.
 */
export async function verifyFullChain(): Promise<{
  valid: boolean;
  firstInvalidId?: string;
  totalEvents: number;
}> {
  const startMs = performance.now();
  eventStreamVerifyRunsTotal.inc();

  const client = await pool.connect();
  try {
    let totalEvents = 0;
    let expectedPrevHash = "GENESIS";

    // Use a cursor to avoid loading the entire table into memory
    await client.query("BEGIN");
    await client.query(
      `DECLARE event_cursor CURSOR FOR
       SELECT id::text, event_type, entity_type, entity_id,
              actor_user_id, payload, previous_event_hash,
              event_hash, created_at
       FROM event_stream ORDER BY id ASC`,
    );

    const BATCH = 1000;
    let done = false;

    while (!done) {
      const { rows } = await client.query<{
        id: string;
        event_type: string;
        entity_type: string;
        entity_id: string | null;
        actor_user_id: string | null;
        payload: Record<string, unknown>;
        previous_event_hash: string;
        event_hash: string;
        created_at: string;
      }>(`FETCH ${BATCH} FROM event_cursor`);

      if (rows.length === 0) {
        done = true;
        break;
      }

      for (const row of rows) {
        totalEvents++;

        if (row.previous_event_hash !== expectedPrevHash) {
          eventStreamVerifyFailuresTotal.inc();
          eventStreamVerifyDurationMs.observe(performance.now() - startMs);
          await client.query("CLOSE event_cursor");
          await client.query("COMMIT");
          return { valid: false, firstInvalidId: row.id, totalEvents };
        }

        const recomputed = computeEventHash({
          event_type: row.event_type,
          entity_type: row.entity_type,
          entity_id: row.entity_id,
          actor_user_id: row.actor_user_id,
          payload: row.payload,
          previous_event_hash: row.previous_event_hash,
          created_at_iso: new Date(row.created_at).toISOString(),
        });

        if (recomputed !== row.event_hash) {
          eventStreamVerifyFailuresTotal.inc();
          eventStreamVerifyDurationMs.observe(performance.now() - startMs);
          await client.query("CLOSE event_cursor");
          await client.query("COMMIT");
          return { valid: false, firstInvalidId: row.id, totalEvents };
        }

        expectedPrevHash = row.event_hash;
      }
    }

    await client.query("CLOSE event_cursor");
    await client.query("COMMIT");

    eventStreamVerifyDurationMs.observe(performance.now() - startMs);
    return { valid: true, totalEvents };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    logger.error({ err, eventType: "event_stream.verify_failed" }, "Chain verification error");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Verify chain starting from a given id.
 */
export async function verifyFrom(startId: string): Promise<{
  valid: boolean;
  firstInvalidId?: string;
  totalEvents: number;
}> {
  const startMs = performance.now();
  eventStreamVerifyRunsTotal.inc();

  // Get the event before startId to seed expectedPrevHash
  const prevResult = await pool.query<{ event_hash: string }>(
    `SELECT event_hash FROM event_stream
     WHERE id < $1 ORDER BY id DESC LIMIT 1`,
    [startId],
  );
  let expectedPrevHash =
    prevResult.rows.length > 0 ? prevResult.rows[0].event_hash : "GENESIS";

  const { rows } = await pool.query<{
    id: string;
    event_type: string;
    entity_type: string;
    entity_id: string | null;
    actor_user_id: string | null;
    payload: Record<string, unknown>;
    previous_event_hash: string;
    event_hash: string;
    created_at: string;
  }>(
    `SELECT id::text, event_type, entity_type, entity_id,
            actor_user_id, payload, previous_event_hash,
            event_hash, created_at
     FROM event_stream WHERE id >= $1 ORDER BY id ASC`,
    [startId],
  );

  let totalEvents = 0;

  for (const row of rows) {
    totalEvents++;

    if (row.previous_event_hash !== expectedPrevHash) {
      eventStreamVerifyFailuresTotal.inc();
      eventStreamVerifyDurationMs.observe(performance.now() - startMs);
      return { valid: false, firstInvalidId: row.id, totalEvents };
    }

    const recomputed = computeEventHash({
      event_type: row.event_type,
      entity_type: row.entity_type,
      entity_id: row.entity_id,
      actor_user_id: row.actor_user_id,
      payload: row.payload,
      previous_event_hash: row.previous_event_hash,
      created_at_iso: new Date(row.created_at).toISOString(),
    });

    if (recomputed !== row.event_hash) {
      eventStreamVerifyFailuresTotal.inc();
      eventStreamVerifyDurationMs.observe(performance.now() - startMs);
      return { valid: false, firstInvalidId: row.id, totalEvents };
    }

    expectedPrevHash = row.event_hash;
  }

  eventStreamVerifyDurationMs.observe(performance.now() - startMs);
  return { valid: true, totalEvents };
}
