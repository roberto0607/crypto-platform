import type { FastifyPluginAsync } from "fastify";

import { config } from "../config";
import { requireUser } from "../auth/requireUser";
import { isGlobalTradingEnabled, isReadOnlyMode } from "../governance/systemFlagService";
import { getOrCreateQuota } from "../governance/quotaService";
import { getCurrentLoadState } from "../governance/loadState";

const statusRoutes: FastifyPluginAsync = async (app) => {

  // GET /status/system — public, no auth
  app.get("/system", { schema: { tags: ["Status"], summary: "System status", description: "Returns global trading state, read-only mode, beta mode, and load status. No authentication required.", response: { 200: { type: "object", properties: { tradingEnabledGlobal: { type: "boolean" }, readOnlyMode: { type: "boolean" }, betaMode: { type: "boolean" }, degraded: { type: "boolean" }, message: { type: "string" } } } } } }, async (_req, reply) => {
    const [tradingEnabledGlobal, readOnlyMode] = await Promise.all([
      isGlobalTradingEnabled(),
      isReadOnlyMode(),
    ]);

    const loadState = getCurrentLoadState();

    return reply.send({
      tradingEnabledGlobal,
      readOnlyMode,
      betaMode: config.betaMode,
      degraded: loadState.isOverloaded,
      ...(loadState.isOverloaded ? { message: "System is under high load." } : {}),
    });
  });

  // GET /status/user — auth required
  app.get("/user", { schema: { tags: ["Status"], summary: "User trading status", description: "Returns user's trading quotas and enabled state.", security: [{ bearerAuth: [] }], response: { 200: { type: "object", properties: { tradingEnabled: { type: "boolean" }, quotas: { type: "object", properties: { maxOrdersPerMin: { type: "integer" }, maxOpenOrders: { type: "integer" }, maxDailyOrders: { type: "integer" } } } } } } }, preHandler: requireUser }, async (req, reply) => {
    const quota = await getOrCreateQuota(req.user!.id);

    return reply.send({
      tradingEnabled: quota.trading_enabled,
      quotas: {
        maxOrdersPerMin: quota.max_orders_per_min,
        maxOpenOrders: quota.max_open_orders,
        maxDailyOrders: quota.max_daily_orders,
      },
    });
  });
};

export default statusRoutes;
