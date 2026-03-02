import type { PoolClient } from "pg";
import { pool } from "../db/pool";
import type { IncidentRow, IncidentEventRow } from "./incidentTypes";

/**
 * Create an incident linked to a reconciliation run.
 * Idempotent: ON CONFLICT (user_id, recon_run_id) DO NOTHING.
 * Returns the incident id (existing or newly created).
 */
export async function createIncidentFromReconTx(
  client: PoolClient,
  params: {
    userId: string;
    reconRunId: string;
    severity?: string;
    latestReportId?: string;
  },
): Promise<string> {
  await client.query(
    `INSERT INTO incidents (user_id, recon_run_id, severity, latest_report_id, opened_by, opened_reason)
     VALUES ($1, $2, $3, $4, 'SYSTEM', 'RECONCILIATION_QUARANTINE')
     ON CONFLICT (user_id, recon_run_id) WHERE recon_run_id IS NOT NULL
     DO NOTHING`,
    [
      params.userId,
      params.reconRunId,
      params.severity ?? "HIGH",
      params.latestReportId ?? null,
    ],
  );

  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM incidents WHERE user_id = $1 AND recon_run_id = $2`,
    [params.userId, params.reconRunId],
  );

  return rows[0].id;
}

/**
 * Append an event to an incident timeline (insert-only).
 */
export async function appendEventTx(
  client: PoolClient,
  params: {
    incidentId: string;
    eventType: string;
    actorUserId?: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO incident_events (incident_id, event_type, actor_user_id, metadata)
     VALUES ($1, $2, $3, $4)`,
    [
      params.incidentId,
      params.eventType,
      params.actorUserId ?? null,
      JSON.stringify(params.metadata ?? {}),
    ],
  );
}

/**
 * Get a single incident by id.
 */
export async function getIncidentById(id: string): Promise<IncidentRow | null> {
  const { rows } = await pool.query<IncidentRow>(
    `SELECT * FROM incidents WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

/**
 * List incidents with optional filters, paginated.
 */
export async function listIncidents(filters: {
  status?: string;
  userId?: string;
  from?: string;
  to?: string;
  limit: number;
  offset: number;
}): Promise<{ rows: IncidentRow[]; total: number }> {
  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (filters.status) {
    conditions.push(`status = $${idx++}`);
    values.push(filters.status);
  }
  if (filters.userId) {
    conditions.push(`user_id = $${idx++}`);
    values.push(filters.userId);
  }
  if (filters.from) {
    conditions.push(`created_at >= $${idx++}`);
    values.push(filters.from);
  }
  if (filters.to) {
    conditions.push(`created_at <= $${idx++}`);
    values.push(filters.to);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const countResult = await pool.query<{ cnt: string }>(
    `SELECT COUNT(*) AS cnt FROM incidents ${where}`,
    values,
  );
  const total = parseInt(countResult.rows[0].cnt, 10);

  const dataResult = await pool.query<IncidentRow>(
    `SELECT * FROM incidents ${where} ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx++}`,
    [...values, filters.limit, filters.offset],
  );

  return { rows: dataResult.rows, total };
}

/**
 * List all events for an incident, ordered chronologically.
 */
export async function listEvents(incidentId: string): Promise<IncidentEventRow[]> {
  const { rows } = await pool.query<IncidentEventRow>(
    `SELECT * FROM incident_events WHERE incident_id = $1 ORDER BY created_at ASC`,
    [incidentId],
  );
  return rows;
}

/**
 * Mark an incident as acknowledged by an admin.
 * Transitions status from OPEN → INVESTIGATING.
 */
export async function acknowledgeIncidentTx(
  client: PoolClient,
  incidentId: string,
  adminId: string,
): Promise<void> {
  await client.query(
    `UPDATE incidents
     SET acknowledged_by = $1,
         acknowledged_at = now(),
         status = 'INVESTIGATING'
     WHERE id = $2 AND status = 'OPEN'`,
    [adminId, incidentId],
  );
}

/**
 * Mark an incident as resolved.
 */
export async function resolveIncidentTx(
  client: PoolClient,
  incidentId: string,
  adminId: string,
  resolutionSummary: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `UPDATE incidents
     SET status = 'RESOLVED',
         resolved_by = $1,
         resolved_at = now(),
         resolution_summary = $2
     WHERE id = $3 AND status IN ('OPEN', 'INVESTIGATING')`,
    [adminId, JSON.stringify(resolutionSummary), incidentId],
  );
}

/**
 * Find the latest OPEN or INVESTIGATING incident for a user.
 */
export async function findOpenIncidentForUser(
  userId: string,
): Promise<IncidentRow | null> {
  const { rows } = await pool.query<IncidentRow>(
    `SELECT * FROM incidents
     WHERE user_id = $1 AND status IN ('OPEN', 'INVESTIGATING')
     ORDER BY created_at DESC
     LIMIT 1`,
    [userId],
  );
  return rows[0] ?? null;
}

/**
 * Find the latest incident for a user (any status, including RESOLVED).
 * Used for unquarantine gating where a resolved incident still satisfies the gate.
 */
export async function findLatestIncidentForUser(
  userId: string,
): Promise<IncidentRow | null> {
  const { rows } = await pool.query<IncidentRow>(
    `SELECT * FROM incidents
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [userId],
  );
  return rows[0] ?? null;
}
