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
  app.post("/invites", async (req, reply) => {
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
  app.get("/invites", async (_req, reply) => {
    const invites = await listInvites();
    return reply.send({ ok: true, invites });
  });

  // POST /v1/admin/invites/:id/disable
  app.post("/invites/:id/disable", async (req, reply) => {
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
  app.post("/system/trading-global", async (req, reply) => {
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
  app.post("/system/read-only", async (req, reply) => {
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
  app.post("/users/:id/quotas", async (req, reply) => {
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
  app.post("/pairs/:id/trading", async (req, reply) => {
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
