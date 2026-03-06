import type { FastifyPluginAsync } from "fastify";
import { requireUser } from "../auth/requireUser";
import { pool } from "../db/pool";
import { getOpenBreakers } from "../risk/breakerRepo";
import {
  priceDislocationKey,
  rateAbuseKey,
  RECONCILIATION_KEY,
} from "../risk/breakerService";
import { listActivePairs } from "../trading/pairRepo";

const riskRoutes: FastifyPluginAsync = async (app) => {

  // GET /risk/status — user-visible trading status
  app.get("/risk/status", { schema: { tags: ["Risk"], summary: "User risk status", description: "Returns whether trading is allowed and any active circuit breakers affecting the user.", security: [{ bearerAuth: [] }], response: { 200: { type: "object", properties: { ok: { type: "boolean" }, trading_allowed: { type: "boolean" }, breakers: { type: "array", items: { type: "object", properties: { breaker_key: { type: "string" }, reason: { type: "string" }, closes_at: { type: "string", nullable: true } } } } } } } }, preHandler: requireUser }, async (req, reply) => {
    const actor = req.user!;
    const client = await pool.connect();
    try {
      // Collect all possible breaker keys for this user
      const pairs = await listActivePairs();
      const keys = [
        RECONCILIATION_KEY,
        rateAbuseKey(actor.id),
        ...pairs.map((p) => priceDislocationKey(p.id)),
      ];

      const openBreakers = await getOpenBreakers(client, keys);

      const breakers = openBreakers.map((b) => ({
        breaker_key: b.breaker_key,
        reason: b.reason,
        closes_at: b.closes_at,
      }));

      return reply.send({
        ok: true,
        trading_allowed: openBreakers.length === 0,
        breakers,
      });
    } finally {
      client.release();
    }
  });
};

export default riskRoutes;
