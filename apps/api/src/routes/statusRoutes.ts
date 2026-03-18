import type { FastifyPluginAsync } from "fastify";

import { config } from "../config";
import { requireUser } from "../auth/requireUser";
import { isGlobalTradingEnabled, isReadOnlyMode } from "../system/systemFlagService";

const statusRoutes: FastifyPluginAsync = async (app) => {

  // GET /status/system — public, no auth
  app.get("/system", { schema: { tags: ["Status"], summary: "System status", description: "Returns global trading state, read-only mode, beta mode. No authentication required.", response: { 200: { type: "object", properties: { tradingEnabledGlobal: { type: "boolean" }, readOnlyMode: { type: "boolean" }, betaMode: { type: "boolean" }, degraded: { type: "boolean" } } } } } }, async (_req, reply) => {
    const [tradingEnabledGlobal, readOnlyMode] = await Promise.all([
      isGlobalTradingEnabled(),
      isReadOnlyMode(),
    ]);

    return reply.send({
      tradingEnabledGlobal,
      readOnlyMode,
      betaMode: config.betaMode,
      degraded: false,
    });
  });

  // GET /status/user — auth required (paper trading: always enabled, no quotas)
  app.get("/user", { schema: { tags: ["Status"], summary: "User trading status", description: "Returns user's trading status.", security: [{ bearerAuth: [] }], response: { 200: { type: "object", properties: { tradingEnabled: { type: "boolean" } } } } }, preHandler: requireUser }, async (_req, reply) => {
    return reply.send({ tradingEnabled: true });
  });
};

export default statusRoutes;
