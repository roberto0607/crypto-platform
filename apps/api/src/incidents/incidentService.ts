import { pool } from "../db/pool";
import { logger } from "../observability/logContext";
import { auditLog } from "../audit/log";
import {
  incidentsOpenTotal,
  incidentsAckTotal,
  incidentsResolvedTotal,
} from "../metrics";
import {
  createIncidentFromReconTx,
  appendEventTx,
  getIncidentById,
  acknowledgeIncidentTx,
  resolveIncidentTx,
  findOpenIncidentForUser,
  findLatestIncidentForUser,
} from "./incidentRepo";

/**
 * Open incidents for each quarantined user (called after recon quarantine commit).
 * Idempotent per (userId, reconRunId).
 */
export async function openIncidentsForQuarantinedUsers(
  reconRunId: string,
  quarantinedUserIds: string[],
): Promise<void> {
  if (quarantinedUserIds.length === 0) return;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    for (const userId of quarantinedUserIds) {
      const incidentId = await createIncidentFromReconTx(client, {
        userId,
        reconRunId,
      });

      await appendEventTx(client, {
        incidentId,
        eventType: "OPENED",
        metadata: { reconRunId },
      });

      await auditLog({
        actorUserId: null,
        action: "INCIDENT_OPENED",
        targetType: "user",
        targetId: userId,
        metadata: { incidentId, reconRunId },
      });

      incidentsOpenTotal.inc();
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    logger.error(
      { eventType: "incident.open_failed", reconRunId, err },
      "Failed to open incidents for quarantined users",
    );
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Admin acknowledges an incident (OPEN → INVESTIGATING).
 */
export async function acknowledgeIncident(
  incidentId: string,
  adminId: string,
  note?: string,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await acknowledgeIncidentTx(client, incidentId, adminId);

    await appendEventTx(client, {
      incidentId,
      eventType: "ACKNOWLEDGED",
      actorUserId: adminId,
      metadata: note ? { note } : {},
    });

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  await auditLog({
    actorUserId: adminId,
    action: "INCIDENT_ACK",
    targetType: "incident",
    targetId: incidentId,
    metadata: { note: note ?? null },
  });

  incidentsAckTotal.inc();
}

/**
 * Admin adds a note to an incident timeline.
 */
export async function addNote(
  incidentId: string,
  adminId: string,
  note: string,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await appendEventTx(client, {
      incidentId,
      eventType: "NOTE",
      actorUserId: adminId,
      metadata: { note },
    });

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  await auditLog({
    actorUserId: adminId,
    action: "INCIDENT_NOTE",
    targetType: "incident",
    targetId: incidentId,
    metadata: { note },
  });
}

/**
 * Admin resolves an incident.
 */
export async function resolveIncident(
  incidentId: string,
  adminId: string,
  resolutionSummary: Record<string, unknown>,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await resolveIncidentTx(client, incidentId, adminId, resolutionSummary);

    await appendEventTx(client, {
      incidentId,
      eventType: "RESOLVED",
      actorUserId: adminId,
      metadata: { resolutionSummary },
    });

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  await auditLog({
    actorUserId: adminId,
    action: "INCIDENT_RESOLVED",
    targetType: "incident",
    targetId: incidentId,
    metadata: { resolutionSummary },
  });

  incidentsResolvedTotal.inc();
}

/**
 * Check incident gating policy for unquarantine.
 * Returns { allowed, missing } where missing lists unmet conditions.
 */
export async function requireIncidentGateForUnquarantine(
  userId: string,
): Promise<{ allowed: boolean; missing: string[] }> {
  const missing: string[] = [];

  const incident = await findLatestIncidentForUser(userId);

  if (!incident) {
    missing.push("NO_INCIDENT");
    return { allowed: false, missing };
  }

  if (!incident.acknowledged_by) {
    missing.push("ACKNOWLEDGEMENT");
  }

  // Check latest global recon run for HIGH findings for this user.
  // Use the latest run_id globally (not per-user), because a clean run
  // may produce zero rows for this user (meaning no findings = clean).
  const latestRunResult = await pool.query<{ run_id: string }>(
    `SELECT run_id FROM reconciliation_reports
     ORDER BY created_at DESC
     LIMIT 1`,
  );

  if (latestRunResult.rows.length > 0) {
    const latestRunId = latestRunResult.rows[0].run_id;
    const highResult = await pool.query<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt FROM reconciliation_reports
       WHERE run_id = $1 AND user_id = $2 AND severity = 'HIGH'`,
      [latestRunId, userId],
    );
    const highCount = parseInt(highResult.rows[0].cnt, 10);
    if (highCount > 0) {
      missing.push("CLEAN_RECON");
    }
  } else {
    missing.push("CLEAN_RECON");
  }

  if (incident.status !== "RESOLVED") {
    missing.push("RESOLUTION");
  }

  return { allowed: missing.length === 0, missing };
}

/**
 * Append repair events to an open incident for a user (if one exists).
 * Additive: no-op if no open incident.
 */
export async function appendRepairEventsIfIncident(
  userId: string,
  repairRunId: string,
  eventType: "REPAIR_STARTED" | "REPAIR_APPLIED",
  metadata?: Record<string, unknown>,
): Promise<void> {
  const incident = await findOpenIncidentForUser(userId);
  if (!incident) return;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await appendEventTx(client, {
      incidentId: incident.id,
      eventType,
      metadata: { repairRunId, ...metadata },
    });

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    logger.error(
      { eventType: "incident.repair_event_failed", repairRunId, err },
      "Failed to append repair event to incident",
    );
    // Non-blocking: don't throw — repair should still succeed
  } finally {
    client.release();
  }
}
