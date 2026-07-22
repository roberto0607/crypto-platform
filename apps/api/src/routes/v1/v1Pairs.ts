import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import { requireUser } from "../../auth/requireUser";
import { v1HandleError } from "../../http/v1Error";
import { parseLimit } from "../../http/pagination";
import { listActivePairsForDisplay } from "../../trading/pairRepo";
import { pool } from "../../db/pool.js";

const pairsQuery = z.object({
    limit: z.string().optional(),
    search: z.string().optional(),
});

const v1Pairs: FastifyPluginAsync = async (app) => {
    app.get("/pairs", {
        schema: {
            tags: ["Pairs"],
            summary: "List trading pairs (v1 paginated)",
            description: "Returns active trading pairs with optional limit. `search` does trigram-ranked symbol search (datafeed searchSymbols) instead of returning the full list.",
            security: [{ bearerAuth: [] }],
            querystring: {
                type: "object",
                properties: {
                    limit: { type: "string", description: "Max results to return (default 50, max 100; default 20 when searching)" },
                    search: { type: "string", description: "Trigram-ranked symbol search (e.g. \"btc\")" },
                },
            },
            response: {
                200: {
                    type: "object",
                    properties: {
                        data: { type: "array", items: { type: "object", additionalProperties: true } },
                        nextCursor: { type: "string", nullable: true },
                    },
                },
            },
        },
        preHandler: requireUser,
    }, async (req, reply) => {
        try {
            const queryParsed = pairsQuery.safeParse(req.query);
            const q = queryParsed.success ? queryParsed.data : {};

            const pairs = q.search
                ? await listActivePairsForDisplay({ search: q.search, limit: q.limit ? parseLimit(q.limit) : undefined })
                : await listActivePairsForDisplay({ limit: parseLimit(q.limit) });

            return reply.send({ data: pairs, nextCursor: null });
        } catch (err) {
            return v1HandleError(reply, err);
        }
    });

    app.get("/pairs/:pairId/candles", {
        schema: {
            tags: ["Pairs"],
            summary: "Get candle data for a trading pair",
            security: [{ bearerAuth: [] }],
            params: {
                type: "object",
                required: ["pairId"],
                properties: {
                    pairId: { type: "string", format: "uuid" },
                },
            },
            querystring: {
                type: "object",
                properties: {
                    timeframe: {
                        type: "string",
                        enum: ["1m", "5m", "15m", "1h", "4h", "1d"],
                        default: "1h",
                    },
                    limit: { type: "integer", minimum: 1, maximum: 5000, default: 200 },
                    before: { type: "string", description: "ISO timestamp — fetch candles before this time" },
                },
            },
            response: {
                200: {
                    type: "object",
                    properties: {
                        ok: { type: "boolean", const: true },
                        candles: {
                            type: "array",
                            items: {
                                type: "object",
                                properties: {
                                    ts: { type: "string" },
                                    open: { type: "string" },
                                    high: { type: "string" },
                                    low: { type: "string" },
                                    close: { type: "string" },
                                    volume: { type: "string" },
                                },
                            },
                        },
                    },
                },
            },
        },
        preHandler: requireUser,
    }, async (req, reply) => {
        try {
            const { pairId } = req.params as { pairId: string };
            const query = req.query as { timeframe?: string; limit?: number; before?: string };

            const timeframe = query.timeframe ?? "1h";
            const limit = Math.min(query.limit ?? 200, 5000);

            let sql = `SELECT ts, open, high, low, close, volume, buy_volume, sell_volume
                       FROM candles
                       WHERE pair_id = $1 AND timeframe = $2`;
            const params: (string | number)[] = [pairId, timeframe];

            if (query.before) {
                params.push(query.before);
                sql += ` AND ts < $${params.length}`;
            }

            params.push(limit);
            sql += ` ORDER BY ts DESC LIMIT $${params.length}`;

            const { rows } = await pool.query(sql, params);

            // Return in ascending order (oldest first) for charting
            rows.reverse();

            return reply.send({ ok: true, candles: rows });
        } catch (err) {
            return v1HandleError(reply, err);
        }
    });
};

export default v1Pairs;
