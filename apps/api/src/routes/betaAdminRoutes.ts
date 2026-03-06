import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import { requireUser } from "../auth/requireUser";
import { requireRole } from "../auth/requireRole";
import { auditLog } from "../audit/log";
import { handleError } from "../http/handleError";
import { AppError } from "../errors/AppError";
import { createInvite, listInvites, disableInvite } from "../beta/inviteRepo";
import { getOrCreateQuota, updateQuotas } from "../governance/quotaService";
import { getFlag, setFlag, setPairTradingEnabled } from "../governance/systemFlagService";

// ── Zod schemas ──
const createInviteBody = z.object({
  code: z.string().min(1).max(64),
  maxUses: z.number().int().min(1).default(1),
  expiresAt: z.string().datetime().optional(),
});

const idParams = z.object({ id: z.string().uuid() });

const enabledBody = z.object({ enabled: z.boolean() });

const updateQuotaBody = z.object({
  maxOrdersPerMin: z.number().int().min(1).optional(),
  maxOpenOrders: z.number().int().min(1).optional(),
  maxDailyOrders: z.number().int().min(1).optional(),
  tradingEnabled: z.boolean().optional(),
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

  // ── User quotas ──

  // POST /v1/admin/users/:id/quotas
  app.post("/users/:id/quotas", { schema: { tags: ["Admin"], summary: "Update user quotas", description: "Updates trading quotas for a specific user. Requires ADMIN role.", security: [{ bearerAuth: [] }], params: { type: "object", required: ["id"], properties: { id: { type: "string", format: "uuid" } } }, body: { type: "object", properties: { maxOrdersPerMin: { type: "integer", minimum: 1 }, maxOpenOrders: { type: "integer", minimum: 1 }, maxDailyOrders: { type: "integer", minimum: 1 }, tradingEnabled: { type: "boolean" } } }, response: { 200: { type: "object", properties: { ok: { type: "boolean" }, quotas: { type: "object", additionalProperties: true } } }, 400: { type: "object", properties: { ok: { type: "boolean" }, error: { type: "string" } } } } } }, async (req, reply) => {
    const paramsParsed = idParams.safeParse(req.params);
    if (!paramsParsed.success) {
      return reply.code(400).send({ ok: false, error: "invalid_input" });
    }

    const parsed = updateQuotaBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: "invalid_input", details: parsed.error.flatten() });
    }

    const quotas = await updateQuotas(paramsParsed.data.id, {
      max_orders_per_min: parsed.data.maxOrdersPerMin,
      max_open_orders: parsed.data.maxOpenOrders,
      max_daily_orders: parsed.data.maxDailyOrders,
      trading_enabled: parsed.data.tradingEnabled,
    });

    await auditLog({
      actorUserId: req.user!.id,
      action: "admin.quota.update",
      targetType: "user",
      targetId: paramsParsed.data.id,
      requestId: req.id,
      ip: req.ip,
      userAgent: req.headers["user-agent"] ?? null,
      metadata: parsed.data,
    });

    return reply.send({ ok: true, quotas });
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
