import type { PoolClient } from "pg";
import { pool } from "../db/pool";
import type { EventStreamRow } from "./eventTypes";

const COLUMNS = `id::text, event_type, entity_type, entity_id, actor_user_id,
  payload, previous_event_hash, event_hash, created_at`;

/**
 * Get the latest event_hash from the chain.
 * Returns "GENESIS" if the table is empty.
 * Must be called inside the caller's transaction for consistency.
 */
export async function getLatestEventHash(client: PoolClient): Promise<string> {
  const { rows } = await client.query<{ event_hash: string }>(
    `SELECT event_hash FROM event_stream ORDER BY id DESC LIMIT 1`,
  );
  return rows.length > 0 ? rows[0].event_hash : "GENESIS";
}

/**
 * Append a fully-computed event row inside a caller-managed transaction.
 */
export async function appendEventTx(
  client: PoolClient,
  input: {
    eventType: string;
    entityType: string;
    entityId?: string | null;
    actorUserId?: string | null;
    payload: Record<string, unknown>;
    previousEventHash: string;
    eventHash: string;
    createdAt: Date;
  },
): Promise<EventStreamRow> {
  const { rows } = await client.query<EventStreamRow>(
    `INSERT INTO event_stream
       (event_type, entity_type, entity_id, actor_user_id, payload,
        previous_event_hash, event_hash, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING ${COLUMNS}`,
    [
      input.eventType,
      input.entityType,
      input.entityId ?? null,
      input.actorUserId ?? null,
      JSON.stringify(input.payload),
      input.previousEventHash,
      input.eventHash,
      input.createdAt,
    ],
  );
  return rows[0];
}

/**
 * Paginated list of events with optional filters.
 */
export async function listEvents(filters: {
  fromId?: string;
  entityType?: string;
  entityId?: string;
  limit: number;
}): Promise<{ rows: EventStreamRow[]; total: number }> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (filters.fromId) {
    conditions.push(`id >= $${idx++}`);
    params.push(filters.fromId);
  }
  if (filters.entityType) {
    conditions.push(`entity_type = $${idx++}`);
    params.push(filters.entityType);
  }
  if (filters.entityId) {
    conditions.push(`entity_id = $${idx++}`);
    params.push(filters.entityId);
  }

  const where = conditions.length > 0 ? "WHERE " + conditions.join(" AND ") : "";

  const countResult = await pool.query<{ cnt: string }>(
    `SELECT COUNT(*) AS cnt FROM event_stream ${where}`,
    params,
  );
  const total = parseInt(countResult.rows[0].cnt, 10);

  params.push(filters.limit);
  const { rows } = await pool.query<EventStreamRow>(
    `SELECT ${COLUMNS} FROM event_stream ${where}
     ORDER BY id ASC
     LIMIT $${idx}`,
    params,
  );

  return { rows, total };
}

/**
 * Get a single event by id.
 */
export async function getEventById(id: string): Promise<EventStreamRow | null> {
  const { rows } = await pool.query<EventStreamRow>(
    `SELECT ${COLUMNS} FROM event_stream WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}
