import type { FastifyPluginAsync } from "fastify";

import { config } from "../config";
import { requireUser } from "../auth/requireUser";
import { isGlobalTradingEnabled, isReadOnlyMode } from "../governance/systemFlagService";
import { getOrCreateQuota } from "../governance/quotaService";
import { getCurrentLoadState } from "../governance/loadState";

const statusRoutes: FastifyPluginAsync = async (app) => {

  // GET /status/system — public, no auth
  app.get("/system", async (_req, reply) => {
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
  app.get("/user", { preHandler: requireUser }, async (req, reply) => {
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
