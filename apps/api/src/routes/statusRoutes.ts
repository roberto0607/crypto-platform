import type { FastifyPluginAsync } from "fastify";

import { config } from "../config";
import { requireUser } from "../auth/requireUser";
import { isGlobalTradingEnabled, isReadOnlyMode } from "../system/systemFlagService";

const statusRoutes: FastifyPluginAsync = async (app) => {

  // Per-route rate-limit override: /status/system gets its own dedicated bucket,
  // independent of the global 100/min-per-IP limit (app.ts).
  //
  // Pattern established by PR #35 (/health, b291dd0): cold-load-critical read
  // endpoints that every tab hits on startup starve the shared global bucket
  // when ~5+ tabs cold-load from one IP. Driven by the MEDIUM follow-on filed in
  // docs/followups.md ("Other endpoints starve the global rate-limit bucket under
  // multi-tab load") — /status/system is in App.tsx's cold-load batch.
  // Threshold: 60/min = 6-12x cold-load worst case (5 tabs * 1-2 init requests
  // per tab/min ≈ 5-10 req/min). Tighter than /health's 120/min — this does real
  // DB work (system-flag reads), /health is cheap.
  // NOTE: this override applies ONLY to /system. The sibling /status/user route
  // (authenticated) stays on the global 100/min default.
  const statusSystemRateLimit = { config: { rateLimit: { max: 60, timeWindow: 60_000 } } };

  // GET /status/system — public, no auth
  app.get("/system", { ...statusSystemRateLimit, schema: { tags: ["Status"], summary: "System status", description: "Returns global trading state, read-only mode, beta mode. No authentication required.", response: { 200: { type: "object", properties: { tradingEnabledGlobal: { type: "boolean" }, readOnlyMode: { type: "boolean" }, betaMode: { type: "boolean" }, degraded: { type: "boolean" } } } } } }, async (_req, reply) => {
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
