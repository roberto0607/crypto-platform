import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import { requireUser } from "../auth/requireUser";
import { requireRole } from "../auth/requireRole";
import { auditLog } from "../audit/log";
import { handleError } from "../http/handleError";
import { AppError } from "../errors/AppError";
import { createInvite, listInvites, disableInvite } from "../beta/inviteRepo";
import { setFlag, setPairTradingEnabled } from "../system/systemFlagService";
import { cancelAllOrdersWithOutbox } from "../trading/phase6OrderService";

// ── Zod schemas ──
const createInviteBody = z.object({
  code: z.string().min(1).max(64),
  maxUses: z.number().int().min(1).default(1),
  expiresAt: z.string().datetime().optional(),
});

const idParams = z.object({ id: z.string().uuid() });

const enabledBody = z.object({ enabled: z.boolean() });

const cancelAllBody = z.object({
  pairId: z.string().uuid().optional(),
  userId: z.string().uuid().optional(),
  source: z.string().optional(),
});


// ── Plugin ──
const betaAdminRoutes: FastifyPluginAsync = async (app) => {

  // All routes require admin
  app.addHook("preHandler", requireUser);
  app.addHook("preHandler", requireRole("ADMIN"));

  // ── Invites ──

  // POST /v1/admin/invites
  app.post("/invites", { schema: { tags: ["Admin"], summary: "Create beta invite", description: "Creates a new beta invite code. Requires ADMIN role.", security: [{ bearerAuth: [] }], body: { type: "object", required: ["code"], properties: { code: { type: "string", minLength: 1, maxLength: 64 }, maxUses: { type: "integer", minimum: 1, default: 1 }, expiresAt: { type: "string", format: "date-time" } } }, response: { 201: { type: "object", properties: { ok: { type: "boolean" }, invite: { type: "object", additionalProperties: true } } }, 400: { type: "object", properties: { ok: { type: "boolean" }, error: { type: "string" } } }, 409: { type: "object", properties: { ok: { type: "boolean" }, error: { type: "string" } } } } } }, async (req, reply) => {
    const parsed = createInviteBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: "invalid_input", details: parsed.error.flatten() });
    }

    try {
      const invite = await createInvite(
        parsed.data.code,
        req.user!.id,
        parsed.data.maxUses,
        parsed.data.expiresAt ?? null,
      );

      await auditLog({
        actorUserId: req.user!.id,
        action: "beta.invite.create",
        targetType: "invite",
        targetId: invite.id,
        requestId: req.id,
        ip: req.ip,
        userAgent: req.headers["user-agent"] ?? null,
        metadata: { code: parsed.data.code, maxUses: parsed.data.maxUses },
      });

      return reply.code(201).send({ ok: true, invite });
    } catch (err: any) {
      if (err?.code === "23505") {
        return reply.code(409).send({ ok: false, error: "invite_code_taken" });
      }
      return handleError(reply, err);
    }
  });

  // GET /v1/admin/invites
  app.get("/invites", { schema: { tags: ["Admin"], summary: "List beta invites", description: "Returns all beta invite codes. Requires ADMIN role.", security: [{ bearerAuth: [] }], response: { 200: { type: "object", properties: { ok: { type: "boolean" }, invites: { type: "array", items: { type: "object", additionalProperties: true } } } } } } }, async (_req, reply) => {
    const invites = await listInvites();
    return reply.send({ ok: true, invites });
  });

  // POST /v1/admin/invites/:id/disable
  app.post("/invites/:id/disable", { schema: { tags: ["Admin"], summary: "Disable a beta invite", description: "Disables an invite code so it can no longer be used. Requires ADMIN role.", security: [{ bearerAuth: [] }], params: { type: "object", required: ["id"], properties: { id: { type: "string", format: "uuid" } } }, response: { 200: { type: "object", properties: { ok: { type: "boolean" }, invite: { type: "object", additionalProperties: true } } }, 400: { type: "object", properties: { ok: { type: "boolean" }, error: { type: "string" } } }, 404: { type: "object", properties: { ok: { type: "boolean" }, error: { type: "string" } } } } } }, async (req, reply) => {
    const paramsParsed = idParams.safeParse(req.params);
    if (!paramsParsed.success) {
      return reply.code(400).send({ ok: false, error: "invalid_input" });
    }

    const invite = await disableInvite(paramsParsed.data.id);
    if (!invite) {
      return reply.code(404).send({ ok: false, error: "invite_not_found" });
    }

    await auditLog({
      actorUserId: req.user!.id,
      action: "beta.invite.disable",
      targetType: "invite",
      targetId: invite.id,
      requestId: req.id,
      ip: req.ip,
      userAgent: req.headers["user-agent"] ?? null,
    });

    return reply.send({ ok: true, invite });
  });

  // ── System flags ──

  // POST /v1/admin/system/trading-global
  app.post("/system/trading-global", { schema: { tags: ["Admin"], summary: "Toggle global trading", description: "Enables or disables trading globally. Requires ADMIN role.", security: [{ bearerAuth: [] }], body: { type: "object", required: ["enabled"], properties: { enabled: { type: "boolean" } } }, response: { 200: { type: "object", properties: { ok: { type: "boolean" } } }, 400: { type: "object", properties: { ok: { type: "boolean" }, error: { type: "string" } } } } } }, async (req, reply) => {
    const parsed = enabledBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: "invalid_input" });
    }

    await setFlag("TRADING_ENABLED_GLOBAL", { enabled: parsed.data.enabled });

    await auditLog({
      actorUserId: req.user!.id,
      action: "system.trading_global",
      requestId: req.id,
      ip: req.ip,
      userAgent: req.headers["user-agent"] ?? null,
      metadata: { enabled: parsed.data.enabled },
    });

    return reply.send({ ok: true });
  });

  // POST /v1/admin/system/read-only
  app.post("/system/read-only", { schema: { tags: ["Admin"], summary: "Toggle read-only mode", description: "Enables or disables read-only mode for the platform. Requires ADMIN role.", security: [{ bearerAuth: [] }], body: { type: "object", required: ["enabled"], properties: { enabled: { type: "boolean" } } }, response: { 200: { type: "object", properties: { ok: { type: "boolean" } } }, 400: { type: "object", properties: { ok: { type: "boolean" }, error: { type: "string" } } } } } }, async (req, reply) => {
    const parsed = enabledBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: "invalid_input" });
    }

    await setFlag("READ_ONLY_MODE", { enabled: parsed.data.enabled });

    await auditLog({
      actorUserId: req.user!.id,
      action: "system.read_only",
      requestId: req.id,
      ip: req.ip,
      userAgent: req.headers["user-agent"] ?? null,
      metadata: { enabled: parsed.data.enabled },
    });

    return reply.send({ ok: true });
  });

  // POST /v1/admin/system/agent-actions
  app.post("/system/agent-actions", { schema: { tags: ["Admin"], summary: "Toggle agent-actions kill switch", description: "Enables or disables agent-originated order placement (orders tagged source='agent'). Manual user trading is never affected. Requires ADMIN role.", security: [{ bearerAuth: [] }], body: { type: "object", required: ["enabled"], properties: { enabled: { type: "boolean" } } }, response: { 200: { type: "object", properties: { ok: { type: "boolean" } } }, 400: { type: "object", properties: { ok: { type: "boolean" }, error: { type: "string" } } } } } }, async (req, reply) => {
    const parsed = enabledBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: "invalid_input" });
    }

    await setFlag("AGENT_ACTIONS_ENABLED", { enabled: parsed.data.enabled });

    await auditLog({
      actorUserId: req.user!.id,
      action: "system.agent_actions",
      requestId: req.id,
      ip: req.ip,
      userAgent: req.headers["user-agent"] ?? null,
      metadata: { enabled: parsed.data.enabled },
    });

    return reply.send({ ok: true });
  });

  // ── Emergency order cancellation ──

  // POST /v1/admin/orders/cancel-all
  app.post("/orders/cancel-all", { schema: { tags: ["Admin"], summary: "Bulk-cancel open orders", description: "Cancels every OPEN/PARTIALLY_FILLED order matching the given filters (all optional -- omitting all three cancels every open order platform-wide). Requires ADMIN role.", security: [{ bearerAuth: [] }], body: { type: "object", properties: { pairId: { type: "string", format: "uuid" }, userId: { type: "string", format: "uuid" }, source: { type: "string" } } }, response: { 200: { type: "object", properties: { ok: { type: "boolean" }, canceledCount: { type: "integer" }, skippedCount: { type: "integer" } } }, 400: { type: "object", properties: { ok: { type: "boolean" }, error: { type: "string" } } } } } }, async (req, reply) => {
    const parsed = cancelAllBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: "invalid_input" });
    }

    const result = await cancelAllOrdersWithOutbox(parsed.data, req.id);

    await auditLog({
      actorUserId: req.user!.id,
      action: "admin.orders.cancel_all",
      requestId: req.id,
      ip: req.ip,
      userAgent: req.headers["user-agent"] ?? null,
      metadata: {
        filters: parsed.data,
        canceledOrderIds: result.canceled.map((c) => c.order.id),
        skipped: result.skipped,
      },
    });

    return reply.send({ ok: true, canceledCount: result.canceled.length, skippedCount: result.skipped.length });
  });

  // ── Pair trading toggle ──

  // POST /v1/admin/pairs/:id/trading
  app.post("/pairs/:id/trading", { schema: { tags: ["Admin"], summary: "Toggle pair trading", description: "Enables or disables trading for a specific pair. Requires ADMIN role.", security: [{ bearerAuth: [] }], params: { type: "object", required: ["id"], properties: { id: { type: "string", format: "uuid" } } }, body: { type: "object", required: ["enabled"], properties: { enabled: { type: "boolean" } } }, response: { 200: { type: "object", properties: { ok: { type: "boolean" } } }, 400: { type: "object", properties: { ok: { type: "boolean" }, error: { type: "string" } } } } } }, async (req, reply) => {
    const paramsParsed = idParams.safeParse(req.params);
    if (!paramsParsed.success) {
      return reply.code(400).send({ ok: false, error: "invalid_input" });
    }

    const parsed = enabledBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: "invalid_input" });
    }

    await setPairTradingEnabled(paramsParsed.data.id, parsed.data.enabled);

    await auditLog({
      actorUserId: req.user!.id,
      action: "admin.pair.trading",
      targetType: "pair",
      targetId: paramsParsed.data.id,
      requestId: req.id,
      ip: req.ip,
      userAgent: req.headers["user-agent"] ?? null,
      metadata: { enabled: parsed.data.enabled },
    });

    return reply.send({ ok: true });
  });
};

export default betaAdminRoutes;
