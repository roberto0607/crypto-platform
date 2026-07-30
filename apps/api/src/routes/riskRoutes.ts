import type { FastifyPluginAsync } from "fastify";
import { requireUser } from "../auth/requireUser";
import { isGlobalTradingEnabled, isReadOnlyMode, isAgentActionsEnabled } from "../system/systemFlagService";

const riskRoutes: FastifyPluginAsync = async (app) => {
  // GET /risk/status — was a hardcoded stub (trading_allowed: true always).
  // trading_allowed now reflects the real global kill switch + read-only
  // mode, which apply to every user's manual trading. agent_actions_allowed
  // is reported separately (not folded into trading_allowed) because it
  // gates ONLY orders tagged source='agent' -- see phase6OrderService.ts --
  // and must never read as "manual trading is blocked" when only the
  // agent switch has been flipped off.
  app.get("/status", { schema: { tags: ["Risk"], summary: "User risk status", description: "Returns whether trading is allowed, based on the real TRADING_ENABLED_GLOBAL/READ_ONLY_MODE system flags.", security: [{ bearerAuth: [] }], response: { 200: { type: "object", properties: { ok: { type: "boolean" }, trading_allowed: { type: "boolean" }, agent_actions_allowed: { type: "boolean" }, breakers: { type: "array", items: { type: "object" } } } } } }, preHandler: requireUser }, async (_req, reply) => {
    const [globalEnabled, readOnly, agentEnabled] = await Promise.all([
      isGlobalTradingEnabled(),
      isReadOnlyMode(),
      isAgentActionsEnabled(),
    ]);
    return reply.send({
      ok: true,
      trading_allowed: globalEnabled && !readOnly,
      agent_actions_allowed: agentEnabled,
      breakers: [],
    });
  });
};

export default riskRoutes;
