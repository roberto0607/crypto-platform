import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { pool } from "../../db/pool";
import { ensureMigrations, resetTestData } from "../../testing/resetDb";
import { createTestUser } from "../../testing/fixtures";
import { randomUUID } from "node:crypto";

import {
  openIncidentsForQuarantinedUsers,
  acknowledgeIncident,
  addNote,
  resolveIncident,
  requireIncidentGateForUnquarantine,
  appendRepairEventsIfIncident,
} from "../incidentService";
import { getIncidentById, listEvents } from "../incidentRepo";

/* ── shared state ─────────────────────────────────────────── */
let userId: string;
let adminId: string;

beforeAll(async () => {
  await ensureMigrations();
});

beforeEach(async () => {
  await resetTestData();
  const user = await createTestUser(pool);
  userId = user.id;
  const admin = await createTestUser(pool, { email: "admin@test.com", role: "ADMIN" });
  adminId = admin.id;
});

/* ── helpers ──────────────────────────────────────────────── */

async function createIncidentForUser(uid: string, reconRunId?: string): Promise<string> {
  const rid = reconRunId ?? randomUUID();
  await openIncidentsForQuarantinedUsers(rid, [uid]);
  const inc = await pool.query<{ id: string }>(
    `SELECT id FROM incidents WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [uid],
  );
  return inc.rows[0].id;
}

/* ════════════════════════════════════════════════════════════
   openIncidentsForQuarantinedUsers
   ════════════════════════════════════════════════════════════ */

describe("openIncidentsForQuarantinedUsers", () => {
  it("creates incident for each quarantined user", async () => {
    const user2 = await createTestUser(pool);
    const reconRunId = randomUUID();

    await openIncidentsForQuarantinedUsers(reconRunId, [userId, user2.id]);

    const result = await pool.query(
      `SELECT user_id, status, opened_by, opened_reason, recon_run_id
       FROM incidents ORDER BY created_at`,
    );
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0].status).toBe("OPEN");
    expect(result.rows[0].opened_by).toBe("SYSTEM");
    expect(result.rows[0].opened_reason).toBe("RECONCILIATION_QUARANTINE");
  });

  it("is idempotent — calling twice with same reconRunId creates no duplicates", async () => {
    const reconRunId = randomUUID();

    await openIncidentsForQuarantinedUsers(reconRunId, [userId]);
    await openIncidentsForQuarantinedUsers(reconRunId, [userId]);

    const result = await pool.query(
      `SELECT id FROM incidents WHERE user_id = $1 AND recon_run_id = $2`,
      [userId, reconRunId],
    );
    expect(result.rows).toHaveLength(1);
  });

  it("records OPENED event in incident_events for each incident", async () => {
    const incidentId = await createIncidentForUser(userId);

    const events = await listEvents(incidentId);
    const openedEvents = events.filter((e) => e.event_type === "OPENED");
    expect(openedEvents).toHaveLength(1);
  });

  it("records event in event_stream for each incident", async () => {
    const reconRunId = randomUUID();
    await openIncidentsForQuarantinedUsers(reconRunId, [userId]);

    const result = await pool.query(
      `SELECT event_type FROM event_stream WHERE event_type = 'INCIDENT_OPENED'`,
    );
    expect(result.rows.length).toBeGreaterThanOrEqual(1);
  });
});

/* ════════════════════════════════════════════════════════════
   acknowledgeIncident
   ════════════════════════════════════════════════════════════ */

describe("acknowledgeIncident", () => {
  it("transitions OPEN → INVESTIGATING", async () => {
    const incidentId = await createIncidentForUser(userId);

    await acknowledgeIncident(incidentId, adminId, "Looking into it");

    const inc = await getIncidentById(incidentId);
    expect(inc!.status).toBe("INVESTIGATING");
    expect(inc!.acknowledged_by).toBe(adminId);
  });

  it("records ACKNOWLEDGED event with note", async () => {
    const incidentId = await createIncidentForUser(userId);
    await acknowledgeIncident(incidentId, adminId, "will check");

    const events = await listEvents(incidentId);
    const ackEvents = events.filter((e) => e.event_type === "ACKNOWLEDGED");
    expect(ackEvents).toHaveLength(1);
    expect(ackEvents[0].actor_user_id).toBe(adminId);
  });

  it("no-ops when incident already INVESTIGATING (idempotent)", async () => {
    const incidentId = await createIncidentForUser(userId);
    await acknowledgeIncident(incidentId, adminId);
    // Second ack should not error
    await acknowledgeIncident(incidentId, adminId);

    const inc = await getIncidentById(incidentId);
    expect(inc!.status).toBe("INVESTIGATING");
  });
});

/* ════════════════════════════════════════════════════════════
   addNote
   ════════════════════════════════════════════════════════════ */

describe("addNote", () => {
  it("appends NOTE event to incident timeline", async () => {
    const incidentId = await createIncidentForUser(userId);
    await addNote(incidentId, adminId, "User contacted support");

    const events = await listEvents(incidentId);
    const noteEvents = events.filter((e) => e.event_type === "NOTE");
    expect(noteEvents).toHaveLength(1);
    expect(noteEvents[0].metadata).toEqual({ note: "User contacted support" });
  });
});

/* ════════════════════════════════════════════════════════════
   resolveIncident
   ════════════════════════════════════════════════════════════ */

describe("resolveIncident", () => {
  it("transitions OPEN → RESOLVED", async () => {
    const incidentId = await createIncidentForUser(userId);
    await resolveIncident(incidentId, adminId, { action: "manual fix" });

    const inc = await getIncidentById(incidentId);
    expect(inc!.status).toBe("RESOLVED");
    expect(inc!.resolved_by).toBe(adminId);
    expect(inc!.resolution_summary).toEqual({ action: "manual fix" });
  });

  it("transitions INVESTIGATING → RESOLVED", async () => {
    const incidentId = await createIncidentForUser(userId);
    await acknowledgeIncident(incidentId, adminId);
    await resolveIncident(incidentId, adminId, { outcome: "resolved" });

    const inc = await getIncidentById(incidentId);
    expect(inc!.status).toBe("RESOLVED");
  });

  it("records RESOLVED event in incident_events", async () => {
    const incidentId = await createIncidentForUser(userId);
    await resolveIncident(incidentId, adminId, {});

    const events = await listEvents(incidentId);
    const resolvedEvents = events.filter((e) => e.event_type === "RESOLVED");
    expect(resolvedEvents).toHaveLength(1);
  });

  it("no-ops when already RESOLVED (idempotent)", async () => {
    const incidentId = await createIncidentForUser(userId);
    await resolveIncident(incidentId, adminId, { first: true });
    await resolveIncident(incidentId, adminId, { second: true });

    const inc = await getIncidentById(incidentId);
    // Still first resolution
    expect(inc!.resolution_summary).toEqual({ first: true });
  });
});

/* ════════════════════════════════════════════════════════════
   requireIncidentGateForUnquarantine
   ════════════════════════════════════════════════════════════ */

describe("requireIncidentGateForUnquarantine", () => {
  it("returns missing=['NO_INCIDENT'] when no incident exists for user", async () => {
    const result = await requireIncidentGateForUnquarantine(userId);
    expect(result.allowed).toBe(false);
    expect(result.missing).toContain("NO_INCIDENT");
  });

  it("returns missing=['ACKNOWLEDGEMENT','CLEAN_RECON','RESOLUTION'] when incident is OPEN", async () => {
    await createIncidentForUser(userId);
    const result = await requireIncidentGateForUnquarantine(userId);
    expect(result.allowed).toBe(false);
    expect(result.missing).toContain("ACKNOWLEDGEMENT");
    expect(result.missing).toContain("CLEAN_RECON");
    expect(result.missing).toContain("RESOLUTION");
  });

  it("returns missing=['CLEAN_RECON'] when last recon has HIGH findings", async () => {
    const reconRunId = randomUUID();
    const incidentId = await createIncidentForUser(userId, reconRunId);
    await acknowledgeIncident(incidentId, adminId);
    await resolveIncident(incidentId, adminId, {});

    // Seed a reconciliation report with HIGH severity
    await pool.query(
      `INSERT INTO reconciliation_reports (run_id, user_id, check_name, severity, details)
       VALUES ($1, $2, 'BALANCE_CHECK', 'HIGH', '{}'::jsonb)`,
      [reconRunId, userId],
    );

    const result = await requireIncidentGateForUnquarantine(userId);
    expect(result.allowed).toBe(false);
    expect(result.missing).toContain("CLEAN_RECON");
  });

  it("returns allowed=true when all gates pass (acknowledged + clean recon + resolved)", async () => {
    const reconRunId = randomUUID();
    const incidentId = await createIncidentForUser(userId, reconRunId);
    await acknowledgeIncident(incidentId, adminId);
    await resolveIncident(incidentId, adminId, { resolved: true });

    // Seed a clean reconciliation report (INFO severity, not HIGH)
    await pool.query(
      `INSERT INTO reconciliation_reports (run_id, user_id, check_name, severity, details)
       VALUES ($1, $2, 'BALANCE_CHECK', 'INFO', '{}'::jsonb)`,
      [reconRunId, userId],
    );

    const result = await requireIncidentGateForUnquarantine(userId);
    expect(result.allowed).toBe(true);
    expect(result.missing).toEqual([]);
  });
});

/* ════════════════════════════════════════════════════════════
   appendRepairEventsIfIncident
   ════════════════════════════════════════════════════════════ */

describe("appendRepairEventsIfIncident", () => {
  it("appends repair event to open incident", async () => {
    const incidentId = await createIncidentForUser(userId);

    await appendRepairEventsIfIncident(userId, randomUUID(), "REPAIR_STARTED", { detail: "x" });

    const events = await listEvents(incidentId);
    const repairEvents = events.filter((e) => e.event_type === "REPAIR_STARTED");
    expect(repairEvents).toHaveLength(1);
  });

  it("no-ops when no open incident for user", async () => {
    // No incident exists, should not throw
    await expect(
      appendRepairEventsIfIncident(userId, randomUUID(), "REPAIR_APPLIED"),
    ).resolves.toBeUndefined();
  });

  it("no-ops when incident is already RESOLVED", async () => {
    const incidentId = await createIncidentForUser(userId);
    await resolveIncident(incidentId, adminId, {});

    // findOpenIncidentForUser won't find a RESOLVED incident
    await appendRepairEventsIfIncident(userId, randomUUID(), "REPAIR_APPLIED");

    const events = await listEvents(incidentId);
    const repairEvents = events.filter((e) => e.event_type === "REPAIR_APPLIED");
    expect(repairEvents).toHaveLength(0);
  });
});
