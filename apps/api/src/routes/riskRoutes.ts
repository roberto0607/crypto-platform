import type { FastifyPluginAsync } from "fastify";
import { requireUser } from "../auth/requireUser";

const riskRoutes: FastifyPluginAsync = async (app) => {
  // GET /risk/status — stub: trading is always allowed (paper trading)
  app.get("/status", { schema: { tags: ["Risk"], summary: "User risk status", description: "Returns whether trading is allowed. Paper trading: always allowed.", security: [{ bearerAuth: [] }], response: { 200: { type: "object", properties: { ok: { type: "boolean" }, trading_allowed: { type: "boolean" }, breakers: { type: "array", items: { type: "object" } } } } } }, preHandler: requireUser }, async (_req, reply) => {
    return reply.send({ ok: true, trading_allowed: true, breakers: [] });
  });
};

export default riskRoutes;
