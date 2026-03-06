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
    { schema: { tags: ["Admin"], summary: "Get account limits", description: "Returns trading limits for a specific user. Requires ADMIN role.", security: [{ bearerAuth: [] }], querystring: { type: "object", required: ["userId"], properties: { userId: { type: "string", format: "uuid" } } }, response: { 200: { type: "object", properties: { data: { type: "object", additionalProperties: true } } } } }, preHandler: [requireUser, requireRole("ADMIN")] },
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
    { schema: { tags: ["Admin"], summary: "Upsert account limits", description: "Creates or updates trading limits for a user. Requires ADMIN role.", security: [{ bearerAuth: [] }], body: { type: "object", required: ["userId"], properties: { userId: { type: "string", format: "uuid" }, maxDailyNotionalQuote: { type: "string", nullable: true }, maxDailyRealizedLossQuote: { type: "string", nullable: true }, maxOpenPositions: { type: "integer", nullable: true }, maxOpenOrders: { type: "integer", nullable: true } } }, response: { 200: { type: "object", properties: { data: { type: "object", additionalProperties: true } } } } }, preHandler: [requireUser, requireRole("ADMIN")] },
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
    { schema: { tags: ["Admin"], summary: "Update account status", description: "Changes a user's account status (ACTIVE, SUSPENDED, LOCKED, QUARANTINED). Requires ADMIN role.", security: [{ bearerAuth: [] }], body: { type: "object", required: ["userId", "status"], properties: { userId: { type: "string", format: "uuid" }, status: { type: "string", enum: ["ACTIVE", "SUSPENDED", "LOCKED", "QUARANTINED"] } } }, response: { 200: { type: "object", properties: { data: { type: "object", properties: { userId: { type: "string" }, accountStatus: { type: "string" }, updatedAt: { type: "string" } } } } } } }, preHandler: [requireUser, requireRole("ADMIN")] },
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
