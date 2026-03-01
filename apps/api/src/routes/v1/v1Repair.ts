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
    { preHandler: [requireUser, requireRole("ADMIN")] },
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
    { preHandler: [requireUser, requireRole("ADMIN")] },
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
    { preHandler: [requireUser, requireRole("ADMIN")] },
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
    { preHandler: [requireUser, requireRole("ADMIN")] },
    async (req, reply) => {
      try {
        const { id } = userIdParams.parse(req.params);

        // Find latest run_id from reconciliation_reports
        const latestRun = await pool.query<{ run_id: string }>(
          `SELECT run_id
           FROM reconciliation_reports
           ORDER BY created_at DESC
           LIMIT 1`,
        );

        if (latestRun.rows.length === 0) {
          throw new AppError("no_recon_data");
        }

        const latestRunId = latestRun.rows[0].run_id;

        // Check for HIGH findings for this user in that run
        const highResult = await pool.query<{ cnt: string }>(
          `SELECT COUNT(*) AS cnt
           FROM reconciliation_reports
           WHERE run_id = $1 AND user_id = $2 AND severity = 'HIGH'`,
          [latestRunId, id],
        );

        const highCount = parseInt(highResult.rows[0].cnt, 10);

        if (highCount > 0) {
          throw new AppError("repair_has_high_findings", {
            userId: id,
            latestRunId,
            highCount,
          });
        }

        // Clean — unquarantine
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
          action: "USER_UNQUARANTINED_IF_CLEAN",
          targetType: "user",
          targetId: id,
          requestId: req.id,
          ip: req.ip,
          userAgent: req.headers["user-agent"] ?? null,
          metadata: { userId: id, latestRunId },
        });

        reply.send({
          data: {
            userId: id,
            accountStatus: "ACTIVE",
            latestRunId,
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
    { preHandler: [requireUser, requireRole("ADMIN")] },
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
