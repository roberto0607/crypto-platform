import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import { requireUser } from "../../auth/requireUser";
import { requireRole } from "../../auth/requireRole";
import { auditLog } from "../../audit/log";
import { pool } from "../../db/pool";
import {
  getAccountLimits,
  upsertAccountLimits,
  updateAccountStatus,
} from "../../governance/governanceRepo";
import { v1HandleError } from "../../http/v1Error";
import { accountLocksTotal } from "../../metrics";

// ── Zod schemas ──

const getAccountLimitsQuery = z.object({
  userId: z.string().uuid(),
});

const upsertAccountLimitsBody = z.object({
  userId: z.string().uuid(),
  maxDailyNotionalQuote: z.string().regex(/^\d+(\.\d{1,8})?$/).nullable().optional(),
  maxDailyRealizedLossQuote: z.string().regex(/^\d+(\.\d{1,8})?$/).nullable().optional(),
  maxOpenPositions: z.number().int().min(1).nullable().optional(),
  maxOpenOrders: z.number().int().min(1).nullable().optional(),
});

const patchAccountStatusBody = z.object({
  userId: z.string().uuid(),
  status: z.enum(["ACTIVE", "SUSPENDED", "LOCKED", "QUARANTINED"]),
});

// ── Routes ──

const v1Governance: FastifyPluginAsync = async (app) => {
  // GET /v1/admin/account-limits?userId=<uuid>
  app.get(
    "/admin/account-limits",
    { preHandler: [requireUser, requireRole("ADMIN")] },
    async (req, reply) => {
      try {
        const query = getAccountLimitsQuery.parse(req.query);
        const client = await pool.connect();
        try {
          const row = await getAccountLimits(client, query.userId);
          reply.send({ data: row });
        } finally {
          client.release();
        }
      } catch (err) {
        return v1HandleError(reply, err);
      }
    },
  );

  // PUT /v1/admin/account-limits
  app.put(
    "/admin/account-limits",
    { preHandler: [requireUser, requireRole("ADMIN")] },
    async (req, reply) => {
      try {
        const body = upsertAccountLimitsBody.parse(req.body);
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const row = await upsertAccountLimits(client, {
            userId: body.userId,
            maxDailyNotionalQuote: body.maxDailyNotionalQuote,
            maxDailyRealizedLossQuote: body.maxDailyRealizedLossQuote,
            maxOpenPositions: body.maxOpenPositions,
            maxOpenOrders: body.maxOpenOrders,
          });
          await client.query("COMMIT");

          auditLog({
            actorUserId: req.user.id,
            action: "account_limits.upsert",
            targetType: "user",
            targetId: body.userId,
            requestId: req.id,
            ip: req.ip,
            userAgent: req.headers["user-agent"] ?? null,
            metadata: body,
          });

          reply.send({ data: row });
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

  // PATCH /v1/admin/account-status
  app.patch(
    "/admin/account-status",
    { preHandler: [requireUser, requireRole("ADMIN")] },
    async (req, reply) => {
      try {
        const body = patchAccountStatusBody.parse(req.body);
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const row = await updateAccountStatus(client, body.userId, body.status);
          await client.query("COMMIT");

          if (body.status === "LOCKED" || body.status === "SUSPENDED") {
            accountLocksTotal.inc();
          }

          auditLog({
            actorUserId: req.user.id,
            action: "account_status.update",
            targetType: "user",
            targetId: body.userId,
            requestId: req.id,
            ip: req.ip,
            userAgent: req.headers["user-agent"] ?? null,
            metadata: { status: body.status },
          });

          reply.send({
            data: {
              userId: row.user_id,
              accountStatus: row.account_status,
              updatedAt: row.updated_at,
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

export default v1Governance;
