import type { FastifyPluginAsync } from "fastify";
import { getCurrentGammaSignal } from "../market/optionsGammaService";

const gammaRoutes: FastifyPluginAsync = async (app) => {
    app.get("/api/market/gamma", {
        schema: {
            tags: ["Market"],
            summary: "Get BTC options gamma exposure (max pain, gamma flip, dealer positioning)",
            description: "Aggregates Deribit BTC options data to calculate max pain, net gamma exposure, gamma flip level, and key call/put walls.",
        },
    }, async (_req, reply) => {
        const signal = getCurrentGammaSignal();
        if (!signal) {
            return reply.code(503).send({ ok: false, error: "gamma_not_ready", message: "Waiting for first data fetch" });
        }
        return reply.send({ ok: true, ...signal });
    });
};

export default gammaRoutes;
