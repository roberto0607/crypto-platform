import type { FastifyPluginAsync } from "fastify";
import { getNormalizedSignals } from "../market/signalNormalizer";

const signalRoutes: FastifyPluginAsync = async (app) => {
    app.get("/api/market/signal", {
        schema: {
            tags: ["Market"],
            summary: "Get normalized composite market signal",
            description: "Combines all 5 data streams into a single directional score (-1 bearish to +1 bullish) with dynamic weighting.",
        },
    }, async (_req, reply) => {
        const signals = getNormalizedSignals();
        return reply.send({ ok: true, ...signals });
    });
};

export default signalRoutes;
