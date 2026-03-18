import type { FastifyPluginAsync } from "fastify";
import { bookSnapshots } from "../market/orderFlowFeatures.js";
import { symbolToPairId } from "../market/krakenWs.js";

const krakenBookRoutes: FastifyPluginAsync = async (app) => {
    app.get<{ Params: { symbol: string } }>("/market/book/:symbol", {
        schema: {
            tags: ["Market"],
            summary: "Cached Kraken order book for a symbol",
            params: {
                type: "object",
                required: ["symbol"],
                properties: { symbol: { type: "string" } },
            },
            response: {
                200: {
                    type: "object",
                    properties: {
                        ok: { type: "boolean" },
                        book: {
                            type: "object",
                            properties: {
                                bids: {
                                    type: "array",
                                    items: {
                                        type: "object",
                                        properties: {
                                            price: { type: "string" },
                                            qty: { type: "string" },
                                            count: { type: "string" },
                                        },
                                    },
                                },
                                asks: {
                                    type: "array",
                                    items: {
                                        type: "object",
                                        properties: {
                                            price: { type: "string" },
                                            qty: { type: "string" },
                                            count: { type: "string" },
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
            },
        },
    }, async (req, reply) => {
        // Symbol comes as "BTC-USD" in the URL, convert to "BTC/USD"
        const symbol = req.params.symbol.replace("-", "/");
        const pairId = symbolToPairId[symbol];

        if (!pairId) {
            return reply.send({ ok: true, book: { bids: [], asks: [] } });
        }

        const snap = bookSnapshots.get(pairId);
        if (!snap) {
            return reply.send({ ok: true, book: { bids: [], asks: [] } });
        }

        const bids = snap.bids.map((l) => ({
            price: String(l.price),
            qty: String(l.qty),
            count: "1",
        }));

        const asks = snap.asks.map((l) => ({
            price: String(l.price),
            qty: String(l.qty),
            count: "1",
        }));

        return reply.send({ ok: true, book: { bids, asks } });
    });
};

export default krakenBookRoutes;
