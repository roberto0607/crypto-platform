import type { FastifyPluginAsync } from "fastify";
import { getCurrentRegime } from "../market/regimeClassifier";

const regimeRoutes: FastifyPluginAsync = async (app) => {
    app.get("/api/market/regime", {
        schema: {
            tags: ["Market"],
            summary: "Get current market regime classification",
            description: "Classifies BTC market into TRENDING, RANGING, VOLATILE, MANIPULATED, or TRANSITIONING with adjusted signal weights.",
        },
    }, async (_req, reply) => {
        const regime = getCurrentRegime();
        if (!regime) {
            return reply.code(503).send({ ok: false, error: "regime_not_ready", message: "Waiting for first classification" });
        }
        return reply.send({ ok: true, ...regime });
    });
};

export default regimeRoutes;
