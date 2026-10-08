import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import { requireUser } from "../../auth/requireUser";
import { v1HandleError } from "../../http/v1Error";
import { parseLimit } from "../../http/pagination";
import { listActivePairsForDisplay } from "../../trading/pairRepo";
import { getPublicTickers } from "../../market/publicTickers";
import { bucketStartMs, getFormingCandle, getUnrolledBuckets } from "../../market/formingCandle.js";
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

    // Public — feeds the pre-login ticker strip (login/register/landing).
    app.get("/market/tickers", {
        schema: {
            tags: ["Pairs"],
            summary: "Public price ticker",
            description: "Last price and 24h change for the tradable pairs (MARKET_SYMBOLS). No auth; cached ~10s.",
            response: {
                200: {
                    type: "object",
                    properties: {
                        data: {
                            type: "array",
                            items: {
                                type: "object",
                                properties: {
                                    symbol: { type: "string" },
                                    price: { type: "string", nullable: true },
                                    change24hPct: { type: "number", nullable: true },
                                },
                            },
                        },
                    },
                },
            },
        },
    }, async (_req, reply) => {
        try {
            return reply.send({ data: await getPublicTickers() });
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
                        enum: ["1m", "5m", "15m", "1h", "4h", "1d", "1w"],
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
                                    // Only on the latest page's last row: the
                                    // still-forming bucket (formingCandle.ts).
                                    partial: { type: "boolean" },
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

            // Latest page (no `before`): `limit` finished candles, then the
            // forming bucket appended as `partial: true`. Finished means
            // older than the current bucket — a stored row for the current
            // bucket is superseded by the forming one.
            const nowMs = Date.now();
            const latestPage = !query.before;
            if (query.before) {
                params.push(query.before);
                sql += ` AND ts < $${params.length}`;
            } else {
                params.push(new Date(bucketStartMs(nowMs, timeframe)).toISOString());
                sql += ` AND ts < $${params.length}`;
            }

            params.push(limit);
            sql += ` ORDER BY ts DESC LIMIT $${params.length}`;

            const { rows } = await pool.query(sql, params);

            // Return in ascending order (oldest first) for charting
            rows.reverse();

            if (latestPage) {
                // Just-finished buckets the 60s rollup hasn't stored yet, then
                // the forming one — no missing bar between them.
                const last = rows[rows.length - 1] as { ts: Date | string } | undefined;
                const lastMs = last ? new Date(last.ts).getTime() : null;
                rows.push(...await getUnrolledBuckets(pairId, timeframe, lastMs, nowMs));
                const forming = await getFormingCandle(pairId, timeframe, nowMs);
                if (forming) rows.push(forming);
            }

            return reply.send({ ok: true, candles: rows });
        } catch (err) {
            return v1HandleError(reply, err);
        }
    });
};

export default v1Pairs;
