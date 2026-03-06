import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import { requireUser } from "../../auth/requireUser";
import { requireRole } from "../../auth/requireRole";
import { auditLog } from "../../audit/log";
import { pool } from "../../db/pool";
import { AppError } from "../../errors/AppError";
import { v1HandleError } from "../../http/v1Error";
import { runRepair } from "../../repair/repairOrchestrator";
import { listRepairRuns } from "../../repair/repairRepo";
import { runReconciliation } from "../../reconciliation/reconService";
import { unquarantineUserTx } from "../../reconciliation/quarantineService";
import { requireIncidentGateForUnquarantine } from "../../incidents/incidentService";
import { findOpenIncidentForUser, appendEventTx } from "../../incidents/incidentRepo";

// ── Zod schemas ──

const repairBody = z.object({
  userId: z.string().uuid(),
  pairId: z.string().uuid().optional(),
});

const userIdParams = z.object({
  id: z.string().uuid(),
});

const listRunsQuery = z.object({
  userId: z.string().uuid(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

// ── Routes ──

const v1Repair: FastifyPluginAsync = async (app) => {
  // POST /v1/admin/repair/positions/dry-run
  app.post(
    "/admin/repair/positions/dry-run",
    { schema: { tags: ["Admin"], summary: "Repair positions (dry run)", description: "Simulates position repair without applying changes. Requires ADMIN role.", security: [{ bearerAuth: [] }], body: { type: "object", required: ["userId"], properties: { userId: { type: "string", format: "uuid" }, pairId: { type: "string", format: "uuid" } } }, response: { 200: { type: "object", properties: { data: { type: "object", additionalProperties: true } } } } }, preHandler: [requireUser, requireRole("ADMIN")] },
    async (req, reply) => {
      try {
        const body = repairBody.parse(req.body);
        const result = await runRepair(
          { targetUserId: body.userId, pairId: body.pairId, mode: "DRY_RUN" },
          req.user.id,
        );

        auditLog({
          actorUserId: req.user.id,
          action: "REPAIR_DRY_RUN",
          targetType: "user",
          targetId: body.userId,
          requestId: req.id,
          ip: req.ip,
          userAgent: req.headers["user-agent"] ?? null,
          metadata: {
            repairRunId: result.repairRunId,
            userId: body.userId,
            pairId: body.pairId ?? null,
            changedPairsCount: result.changedPairsCount,
          },
        });

        reply.send({ data: result });
      } catch (err) {
        return v1HandleError(reply, err);
      }
    },
  );

  // POST /v1/admin/repair/positions/apply
  app.post(
    "/admin/repair/positions/apply",
    { schema: { tags: ["Admin"], summary: "Repair positions (apply)", description: "Applies position corrections to resolve discrepancies. Requires ADMIN role.", security: [{ bearerAuth: [] }], body: { type: "object", required: ["userId"], properties: { userId: { type: "string", format: "uuid" }, pairId: { type: "string", format: "uuid" } } }, response: { 200: { type: "object", properties: { data: { type: "object", additionalProperties: true } } } } }, preHandler: [requireUser, requireRole("ADMIN")] },
    async (req, reply) => {
      try {
        const body = repairBody.parse(req.body);
        const result = await runRepair(
          { targetUserId: body.userId, pairId: body.pairId, mode: "APPLY" },
          req.user.id,
        );

        auditLog({
          actorUserId: req.user.id,
          action: "REPAIR_APPLY",
          targetType: "user",
          targetId: body.userId,
          requestId: req.id,
          ip: req.ip,
          userAgent: req.headers["user-agent"] ?? null,
          metadata: {
            repairRunId: result.repairRunId,
            userId: body.userId,
            pairId: body.pairId ?? null,
            updatedPositionsCount: result.updatedPositionsCount,
          },
        });

        reply.send({ data: result });
      } catch (err) {
        return v1HandleError(reply, err);
      }
    },
  );

  // POST /v1/admin/repair/users/:id/reconcile
  app.post(
    "/admin/repair/users/:id/reconcile",
    { schema: { tags: ["Admin"], summary: "Reconcile user", description: "Runs a targeted reconciliation for a specific user. Requires ADMIN role.", security: [{ bearerAuth: [] }], params: { type: "object", required: ["id"], properties: { id: { type: "string", format: "uuid" } } }, response: { 200: { type: "object", properties: { data: { type: "object", additionalProperties: true } } } } }, preHandler: [requireUser, requireRole("ADMIN")] },
    async (req, reply) => {
      try {
        const { id } = userIdParams.parse(req.params);

        // Run full reconciliation, then filter findings for this user
        const result = await runReconciliation();

        // Query findings for this user from the run we just created
        const { rows } = await pool.query<{
          severity: string;
          check_name: string;
          details: Record<string, unknown>;
        }>(
          `SELECT severity, check_name, details
           FROM reconciliation_reports
           WHERE run_id = $1 AND user_id = $2
           ORDER BY severity DESC, check_name`,
          [result.runId, id],
        );

        const highCount = rows.filter((r) => r.severity === "HIGH").length;
        const warnCount = rows.filter((r) => r.severity === "WARN").length;

        auditLog({
          actorUserId: req.user.id,
          action: "reconciliation.targeted_run",
          targetType: "user",
          targetId: id,
          requestId: req.id,
          ip: req.ip,
          userAgent: req.headers["user-agent"] ?? null,
          metadata: { runId: result.runId, highCount, warnCount },
        });

        reply.send({
          data: {
            runId: result.runId,
            findings: rows.map((r) => ({
              severity: r.severity,
              checkName: r.check_name,
              details: r.details,
            })),
            highCount,
            warnCount,
          },
        });
      } catch (err) {
        return v1HandleError(reply, err);
      }
    },
  );

  // POST /v1/admin/repair/users/:id/unquarantine-if-clean
  app.post(
    "/admin/repair/users/:id/unquarantine-if-clean",
    { schema: { tags: ["Admin"], summary: "Unquarantine if clean", description: "Checks all incident gates and unquarantines user if all conditions are met. Requires ADMIN role.", security: [{ bearerAuth: [] }], params: { type: "object", required: ["id"], properties: { id: { type: "string", format: "uuid" } } }, response: { 200: { type: "object", properties: { data: { type: "object", properties: { userId: { type: "string" }, accountStatus: { type: "string" } } } } } } }, preHandler: [requireUser, requireRole("ADMIN")] },
    async (req, reply) => {
      try {
        const { id } = userIdParams.parse(req.params);

        // PR7: Incident gating — check all conditions before unquarantine
        const gate = await requireIncidentGateForUnquarantine(id);

        // Append UNQUARANTINE_ATTEMPT event to incident timeline
        const incident = await findOpenIncidentForUser(id);
        if (incident) {
          const client = await pool.connect();
          try {
            await client.query("BEGIN");
            await appendEventTx(client, {
              incidentId: incident.id,
              eventType: "UNQUARANTINE_ATTEMPT",
              actorUserId: req.user.id,
              metadata: { allowed: gate.allowed, missing: gate.missing },
            });
            await client.query("COMMIT");
          } catch {
            await client.query("ROLLBACK").catch(() => {});
          } finally {
            client.release();
          }
        }

        if (!gate.allowed) {
          auditLog({
            actorUserId: req.user.id,
            action: "UNQUARANTINE_DENIED",
            targetType: "user",
            targetId: id,
            requestId: req.id,
            ip: req.ip,
            userAgent: req.headers["user-agent"] ?? null,
            metadata: { userId: id, missing: gate.missing },
          });

          throw new AppError("unquarantine_not_allowed", {
            missing: gate.missing,
          });
        }

        // All gates passed — unquarantine
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await unquarantineUserTx(client, id, req.user.id);
          await client.query("COMMIT");
        } catch (err) {
          await client.query("ROLLBACK").catch(() => {});
          throw err;
        } finally {
          client.release();
        }

        auditLog({
          actorUserId: req.user.id,
          action: "UNQUARANTINE_APPROVED",
          targetType: "user",
          targetId: id,
          requestId: req.id,
          ip: req.ip,
          userAgent: req.headers["user-agent"] ?? null,
          metadata: { userId: id },
        });

        reply.send({
          data: {
            userId: id,
            accountStatus: "ACTIVE",
          },
        });
      } catch (err) {
        return v1HandleError(reply, err);
      }
    },
  );

  // GET /v1/admin/repair/runs
  app.get(
    "/admin/repair/runs",
    { schema: { tags: ["Admin"], summary: "List repair runs", description: "Returns paginated repair run history for a user. Requires ADMIN role.", security: [{ bearerAuth: [] }], querystring: { type: "object", required: ["userId"], properties: { userId: { type: "string", format: "uuid" }, limit: { type: "integer", minimum: 1, maximum: 100, default: 50 }, offset: { type: "integer", minimum: 0, default: 0 } } }, response: { 200: { type: "object", properties: { data: { type: "array", items: { type: "object", additionalProperties: true } }, total: { type: "integer" } } } } }, preHandler: [requireUser, requireRole("ADMIN")] },
    async (req, reply) => {
      try {
        const query = listRunsQuery.parse(req.query);
        const { rows, total } = await listRepairRuns(
          query.userId,
          query.limit,
          query.offset,
        );

        reply.send({
          data: rows.map((r) => ({
            id: r.id,
            startedBy: r.started_by,
            targetUserId: r.target_user_id,
            mode: r.mode,
            scope: r.scope,
            pairId: r.pair_id,
            status: r.status,
            summary: r.summary,
            error: r.error,
            createdAt: r.created_at,
            finishedAt: r.finished_at,
          })),
          total,
        });
      } catch (err) {
        return v1HandleError(reply, err);
      }
    },
  );
};

export default v1Repair;
