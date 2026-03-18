import type { FastifyPluginAsync } from "fastify";
import { getCurrentOrderBookSignal } from "../market/orderBookAggregator";

const orderBookSignalRoutes: FastifyPluginAsync = async (app) => {
    app.get("/market/orderbook-signal", {
        schema: {
            tags: ["Market"],
            summary: "Get multi-exchange order book imbalance signal",
            description: "Aggregates Coinbase + Kraken order book depth to detect institutional bid/ask pressure.",
        },
    }, async (_req, reply) => {
        const signal = getCurrentOrderBookSignal();
        if (!signal) {
            return reply.code(503).send({ ok: false, error: "signal_not_ready", message: "Waiting for first data fetch" });
        }
        return reply.send({ ok: true, ...signal });
    });
};

export default orderBookSignalRoutes;
