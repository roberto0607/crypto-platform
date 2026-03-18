import type { FastifyPluginAsync } from "fastify";
import { getCurrentOnChainSignal } from "../market/onChainFlowService";

const onChainRoutes: FastifyPluginAsync = async (app) => {
    app.get("/api/market/onchain", {
        schema: {
            tags: ["Market"],
            summary: "Get BTC on-chain exchange flow data",
            description: "Tracks BTC moving onto/off exchanges — the leading indicator for large price moves.",
        },
    }, async (_req, reply) => {
        const signal = getCurrentOnChainSignal();
        if (!signal) {
            return reply.code(503).send({
                ok: false,
                error: "onchain_not_ready",
                message: "Waiting for first data fetch",
                signal: "INSUFFICIENT_DATA",
                confidence: "LOW",
            });
        }
        return reply.send({ ok: true, ...signal });
    });
};

export default onChainRoutes;
