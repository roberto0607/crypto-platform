import type { FastifyPluginAsync } from "fastify";
import { getMarketIntelligence } from "../market/marketIntelligence";

const intelligenceRoutes: FastifyPluginAsync = async (app) => {
    app.get("/market/intelligence", {
        schema: {
            tags: ["Market"],
            summary: "Unified market intelligence — single source of truth",
            description: "Combines all 5 data streams, signal normalization, and regime classification into one synthesized response.",
        },
    }, async (_req, reply) => {
        reply.header("Cache-Control", "no-cache");
        const intel = await getMarketIntelligence();
        return reply.send({ ok: true, ...intel });
    });
};

export default intelligenceRoutes;
