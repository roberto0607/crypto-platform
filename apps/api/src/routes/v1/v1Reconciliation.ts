import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import { requireUser } from "../../auth/requireUser";
import { requireRole } from "../../auth/requireRole";
import { auditLog } from "../../audit/log";
import { pool } from "../../db/pool";
import { listReports, getLatestRunSummary } from "../../reconciliation/reconRepo";
import { runReconciliation } from "../../reconciliation/reconService";
import { unquarantineUserTx } from "../../reconciliation/quarantineService";
import { v1HandleError } from "../../http/v1Error";

// ── Zod schemas ──

const listReportsQuery = z.object({
  userId: z.string().uuid().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  severity: z.enum(["INFO", "WARN", "HIGH"]).optional(),
  check: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const unquarantineParams = z.object({
  id: z.string().uuid(),
});

// ── Routes ──

const v1Reconciliation: FastifyPluginAsync = async (app) => {
  // GET /v1/admin/reconciliation/reports
  app.get(
    "/admin/reconciliation/reports",
    { schema: { tags: ["Admin"], summary: "List reconciliation reports", description: "Returns paginated reconciliation reports. Filter by user, date range, severity, or check name. Requires ADMIN role.", security: [{ bearerAuth: [] }], querystring: { type: "object", properties: { userId: { type: "string", format: "uuid" }, from: { type: "string", format: "date-time" }, to: { type: "string", format: "date-time" }, severity: { type: "string", enum: ["INFO", "WARN", "HIGH"] }, check: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 100, default: 50 }, offset: { type: "integer", minimum: 0, default: 0 } } }, response: { 200: { type: "object", properties: { data: { type: "array", items: { type: "object", additionalProperties: true } }, total: { type: "integer" } } } } }, preHandler: [requireUser, requireRole("ADMIN")] },
    async (req, reply) => {
      try {
        const query = listReportsQuery.parse(req.query);
        const { rows, total } = await listReports({
          userId: query.userId,
          from: query.from,
          to: query.to,
          severity: query.severity,
          checkName: query.check,
          limit: query.limit,
          offset: query.offset,
        });

        reply.send({
          data: rows.map((r) => ({
            id: r.id,
            runId: r.run_id,
            userId: r.user_id,
            severity: r.severity,
            checkName: r.check_name,
            details: r.details,
            createdAt: r.created_at,
          })),
          total,
        });
      } catch (err) {
        return v1HandleError(reply, err);
      }
    },
  );

  // GET /v1/admin/reconciliation/runs/latest
  app.get(
    "/admin/reconciliation/runs/latest",
    { schema: { tags: ["Admin"], summary: "Latest reconciliation run", description: "Returns the summary of the most recent reconciliation run. Requires ADMIN role.", security: [{ bearerAuth: [] }], response: { 200: { type: "object", properties: { data: { type: "object", additionalProperties: true } } } } }, preHandler: [requireUser, requireRole("ADMIN")] },
    async (_req, reply) => {
      const summary = await getLatestRunSummary();
      reply.send({ data: summary });
    },
  );

  // POST /v1/admin/reconciliation/run
  app.post(
    "/admin/reconciliation/run",
    { schema: { tags: ["Admin"], summary: "Trigger reconciliation run", description: "Manually triggers a full reconciliation run. Requires ADMIN role.", security: [{ bearerAuth: [] }], response: { 200: { type: "object", properties: { data: { type: "object", properties: { runId: { type: "string" }, findingsCount: { type: "integer" }, highCount: { type: "integer" }, warnCount: { type: "integer" }, quarantinedUserIds: { type: "array", items: { type: "string" } } } } } } } }, preHandler: [requireUser, requireRole("ADMIN")] },
    async (req, reply) => {
      try {
        const result = await runReconciliation();

        auditLog({
          actorUserId: req.user.id,
          action: "reconciliation.manual_run",
          targetType: "reconciliation",
          requestId: req.id,
          ip: req.ip,
          userAgent: req.headers["user-agent"] ?? null,
          metadata: {
            runId: result.runId,
            findingsCount: result.findingsCount,
            highCount: result.highCount,
            quarantinedUserIds: result.quarantinedUserIds,
          },
        });

        reply.send({
          data: {
            runId: result.runId,
            findingsCount: result.findingsCount,
            highCount: result.highCount,
            warnCount: result.warnCount,
            quarantinedUserIds: result.quarantinedUserIds,
          },
        });
      } catch (err) {
        return v1HandleError(reply, err);
      }
    },
  );

  // POST /v1/admin/users/:id/unquarantine
  app.post(
    "/admin/users/:id/unquarantine",
    { schema: { tags: ["Admin"], summary: "Unquarantine user", description: "Removes quarantine status from a user account. Requires ADMIN role.", security: [{ bearerAuth: [] }], params: { type: "object", required: ["id"], properties: { id: { type: "string", format: "uuid" } } }, response: { 200: { type: "object", properties: { data: { type: "object", properties: { userId: { type: "string" }, accountStatus: { type: "string" }, updatedAt: { type: "string" } } } } } } }, preHandler: [requireUser, requireRole("ADMIN")] },
    async (req, reply) => {
      try {
        const { id } = unquarantineParams.parse(req.params);
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await unquarantineUserTx(client, id, req.user.id);
          await client.query("COMMIT");

          auditLog({
            actorUserId: req.user.id,
            action: "account_status.update",
            targetType: "user",
            targetId: id,
            requestId: req.id,
            ip: req.ip,
            userAgent: req.headers["user-agent"] ?? null,
            metadata: { status: "ACTIVE", previousStatus: "QUARANTINED" },
          });

          reply.send({
            data: {
              userId: id,
              accountStatus: "ACTIVE",
              updatedAt: new Date().toISOString(),
            },
          });
        } catch (err) {
          await client.query("ROLLBACK").catch(() => {});
          throw err;
        } finally {
          client.release();
        }
      } catch (err) {
        return v1HandleError(reply, err);
      }
    },
  );
};

export default v1Reconciliation;
