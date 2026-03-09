import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import { requireUser } from "../../auth/requireUser.js";
import { v1HandleError } from "../../http/v1Error.js";
import {
    getActiveSignal,
    getSignalHistory,
    getSignalPerformance,
    getEquityCurve,
    fetchAndStoreSignal,
} from "../../market/signalService.js";
import { getOrderFlow } from "../../market/orderFlowFeatures.js";
import { getDerivatives, loadDerivativesFromDB } from "../../market/derivativesPoller.js";
import { computeLiquidityZones } from "../../market/liquidityZones.js";
import { fetchPatterns, fetchScenarios } from "../../market/patternService.js";
import { pool } from "../../db/pool.js";

const signalQuery = z.object({
    timeframe: z.enum(["1m", "5m", "15m", "1h", "4h", "1d"]).optional().default("1h"),
    limit: z.coerce.number().int().min(1).max(50).optional().default(20),
});

const v1Signals: FastifyPluginAsync = async (app) => {
    // GET /v1/pairs/:pairId/signals — get active signal + history + performance
    app.get("/pairs/:pairId/signals", {
        schema: {
            tags: ["ML Signals"],
            summary: "Get AI trading signals for a pair",
            security: [{ bearerAuth: [] }],
            params: {
                type: "object",
                required: ["pairId"],
                properties: { pairId: { type: "string", format: "uuid" } },
            },
            querystring: {
                type: "object",
                properties: {
                    timeframe: { type: "string", enum: ["1m", "5m", "15m", "1h", "4h", "1d"] },
                    limit: { type: "number" },
                },
            },
        },
        preHandler: requireUser,
    }, async (req, reply) => {
        try {
            const { pairId } = req.params as { pairId: string };
            const q = signalQuery.parse(req.query);

            const [active, history, performance] = await Promise.all([
                getActiveSignal(pairId, q.timeframe),
                getSignalHistory(pairId, q.timeframe, q.limit),
                getSignalPerformance(pairId, q.timeframe),
            ]);

            return reply.send({
                ok: true,
                active,
                history,
                performance,
            });
        } catch (err) {
            return v1HandleError(reply, err);
        }
    });

    // POST /v1/pairs/:pairId/signals/refresh — force fetch a new signal
    app.post("/pairs/:pairId/signals/refresh", {
        schema: {
            tags: ["ML Signals"],
            summary: "Force refresh AI signal for a pair",
            security: [{ bearerAuth: [] }],
            params: {
                type: "object",
                required: ["pairId"],
                properties: { pairId: { type: "string", format: "uuid" } },
            },
            querystring: {
                type: "object",
                properties: {
                    timeframe: { type: "string", enum: ["1m", "5m", "15m", "1h", "4h", "1d"] },
                },
            },
        },
        preHandler: requireUser,
    }, async (req, reply) => {
        try {
            const { pairId } = req.params as { pairId: string };
            const q = signalQuery.parse(req.query);

            // Look up symbol
            const { rows } = await pool.query<{ symbol: string }>(
                `SELECT symbol FROM trading_pairs WHERE id = $1`,
                [pairId],
            );
            if (rows.length === 0) {
                return reply.status(404).send({ ok: false, error: "Pair not found" });
            }

            const signal = await fetchAndStoreSignal(pairId, rows[0]!.symbol, q.timeframe);

            return reply.send({
                ok: true,
                signal,
                message: signal ? "New signal generated" : "No signal (below confidence or cooldown)",
            });
        } catch (err) {
            return v1HandleError(reply, err);
        }
    });

    // GET /v1/pairs/:pairId/order-flow — real-time order flow features
    app.get("/pairs/:pairId/order-flow", {
        schema: {
            tags: ["ML Signals"],
            summary: "Get real-time order flow features for a pair",
            security: [{ bearerAuth: [] }],
            params: {
                type: "object",
                required: ["pairId"],
                properties: { pairId: { type: "string", format: "uuid" } },
            },
        },
        preHandler: requireUser,
    }, async (req, reply) => {
        try {
            const { pairId } = req.params as { pairId: string };
            const features = getOrderFlow(pairId);

            return reply.send({
                ok: true,
                features,
            });
        } catch (err) {
            return v1HandleError(reply, err);
        }
    });

    // GET /v1/pairs/:pairId/derivatives — real-time derivatives data
    app.get("/pairs/:pairId/derivatives", {
        schema: {
            tags: ["ML Signals"],
            summary: "Get derivatives data (funding, OI, L/S ratios) for a pair",
            security: [{ bearerAuth: [] }],
            params: {
                type: "object",
                required: ["pairId"],
                properties: { pairId: { type: "string", format: "uuid" } },
            },
        },
        preHandler: requireUser,
    }, async (req, reply) => {
        try {
            const { pairId } = req.params as { pairId: string };
            let derivatives = getDerivatives(pairId);
            if (!derivatives) {
                derivatives = await loadDerivativesFromDB(pairId);
            }

            return reply.send({
                ok: true,
                derivatives,
            });
        } catch (err) {
            return v1HandleError(reply, err);
        }
    });

    // GET /v1/pairs/:pairId/confidence-heatmap — historical AI confidence per candle
    app.get("/pairs/:pairId/confidence-heatmap", {
        schema: {
            tags: ["ML Signals"],
            summary: "Get AI confidence heatmap for chart overlay",
            security: [{ bearerAuth: [] }],
            params: {
                type: "object",
                required: ["pairId"],
                properties: { pairId: { type: "string", format: "uuid" } },
            },
            querystring: {
                type: "object",
                properties: {
                    timeframe: { type: "string", enum: ["1m", "5m", "15m", "1h", "4h", "1d"] },
                    limit: { type: "number" },
                },
            },
        },
        preHandler: requireUser,
    }, async (req, reply) => {
        try {
            const { pairId } = req.params as { pairId: string };
            const q = z.object({
                timeframe: z.enum(["1m", "5m", "15m", "1h", "4h", "1d"]).optional().default("1h"),
                limit: z.coerce.number().int().min(1).max(500).optional().default(300),
            }).parse(req.query);

            const tfSeconds: Record<string, number> = {
                "1m": 60, "5m": 300, "15m": 900,
                "1h": 3600, "4h": 14400, "1d": 86400,
            };
            const bucketSec = tfSeconds[q.timeframe] ?? 3600;

            // Generate time buckets going back `limit` periods from now
            const now = Math.floor(Date.now() / 1000);
            const currentBucket = Math.floor(now / bucketSec) * bucketSec;
            const buckets: number[] = [];
            for (let i = q.limit - 1; i >= 0; i--) {
                buckets.push(currentBucket - i * bucketSec);
            }

            // Fetch signals for this pair/timeframe, ordered chronologically
            const { rows: signals } = await pool.query<{
                signal_type: string;
                confidence: string;
                created_at: string;
                expires_at: string;
            }>(
                `SELECT signal_type, confidence, created_at, expires_at
                 FROM ml_signals
                 WHERE pair_id = $1 AND timeframe = $2
                 ORDER BY created_at ASC`,
                [pairId, q.timeframe],
            );

            // Build timeline with decay
            const DECAY_PER_BAR = 5;
            const bars: { ts: number; direction: string; confidence: number }[] = [];

            let lastDirection = "NEUTRAL";
            let lastConfidence = 0;
            let signalIdx = 0;

            for (const bucket of buckets) {
                const bucketMs = bucket * 1000;

                // Check if a signal is active during this bucket
                let found = false;
                while (signalIdx < signals.length) {
                    const sig = signals[signalIdx]!;
                    const createdMs = new Date(sig.created_at).getTime();
                    const expiresMs = new Date(sig.expires_at).getTime();

                    if (createdMs > bucketMs + bucketSec * 1000) break; // future signal
                    if (expiresMs <= bucketMs) {
                        signalIdx++;
                        continue; // expired before this bucket
                    }

                    // Signal is active during this bucket
                    lastDirection = sig.signal_type;
                    lastConfidence = Number(sig.confidence);
                    bars.push({ ts: bucket, direction: lastDirection, confidence: lastConfidence });
                    found = true;
                    break;
                }

                if (!found) {
                    // Decay from last known state
                    lastConfidence = Math.max(0, lastConfidence - DECAY_PER_BAR);
                    if (lastConfidence <= 0) {
                        lastDirection = "NEUTRAL";
                    }
                    bars.push({ ts: bucket, direction: lastDirection, confidence: lastConfidence });
                }
            }

            return reply.send({ ok: true, bars });
        } catch (err) {
            return v1HandleError(reply, err);
        }
    });

    // GET /v1/pairs/:pairId/liquidity-zones — liquidity magnet zones
    app.get("/pairs/:pairId/liquidity-zones", {
        schema: {
            tags: ["ML Signals"],
            summary: "Get liquidity magnet zones for a pair",
            security: [{ bearerAuth: [] }],
            params: {
                type: "object",
                required: ["pairId"],
                properties: { pairId: { type: "string", format: "uuid" } },
            },
            querystring: {
                type: "object",
                properties: {
                    timeframe: { type: "string", enum: ["1m", "5m", "15m", "1h", "4h", "1d"] },
                },
            },
        },
        preHandler: requireUser,
    }, async (req, reply) => {
        try {
            const { pairId } = req.params as { pairId: string };
            const q = z.object({
                timeframe: z.enum(["1m", "5m", "15m", "1h", "4h", "1d"]).optional().default("1h"),
            }).parse(req.query);

            const result = await computeLiquidityZones(pairId, q.timeframe);
            return reply.send({ ok: true, ...result });
        } catch (err) {
            return v1HandleError(reply, err);
        }
    });

    // GET /v1/pairs/:pairId/patterns — detected chart patterns from ML service
    app.get("/pairs/:pairId/patterns", {
        schema: {
            tags: ["ML Signals"],
            summary: "Get detected chart patterns for a pair",
            security: [{ bearerAuth: [] }],
            params: {
                type: "object",
                required: ["pairId"],
                properties: { pairId: { type: "string", format: "uuid" } },
            },
            querystring: {
                type: "object",
                properties: {
                    timeframe: { type: "string", enum: ["1m", "5m", "15m", "1h", "4h", "1d"] },
                },
            },
        },
        preHandler: requireUser,
    }, async (req, reply) => {
        try {
            const { pairId } = req.params as { pairId: string };
            const q = z.object({
                timeframe: z.enum(["1m", "5m", "15m", "1h", "4h", "1d"]).optional().default("1h"),
            }).parse(req.query);

            // Look up symbol
            const { rows } = await pool.query<{ symbol: string }>(
                `SELECT symbol FROM trading_pairs WHERE id = $1`,
                [pairId],
            );
            if (rows.length === 0) {
                return reply.status(404).send({ ok: false, error: "Pair not found" });
            }

            const patterns = await fetchPatterns(rows[0]!.symbol, q.timeframe);
            return reply.send({ ok: true, patterns });
        } catch (err) {
            return v1HandleError(reply, err);
        }
    });

    // GET /v1/pairs/:pairId/scenarios — AI ghost candle scenarios
    app.get("/pairs/:pairId/scenarios", {
        schema: {
            tags: ["ML Signals"],
            summary: "Get AI-predicted ghost candle scenarios (bull/base/bear)",
            security: [{ bearerAuth: [] }],
            params: {
                type: "object",
                required: ["pairId"],
                properties: { pairId: { type: "string", format: "uuid" } },
            },
            querystring: {
                type: "object",
                properties: {
                    timeframe: { type: "string", enum: ["1m", "5m", "15m", "1h", "4h", "1d"] },
                },
            },
        },
        preHandler: requireUser,
    }, async (req, reply) => {
        try {
            const { pairId } = req.params as { pairId: string };
            const q = z.object({
                timeframe: z.enum(["1m", "5m", "15m", "1h", "4h", "1d"]).optional().default("1h"),
            }).parse(req.query);

            // Look up symbol
            const { rows } = await pool.query<{ symbol: string }>(
                `SELECT symbol FROM trading_pairs WHERE id = $1`,
                [pairId],
            );
            if (rows.length === 0) {
                return reply.status(404).send({ ok: false, error: "Pair not found" });
            }

            const result = await fetchScenarios(rows[0]!.symbol, q.timeframe);
            if (!result) {
                return reply.send({
                    ok: true,
                    scenarios: [],
                    currentPrice: 0,
                    generatedAt: new Date().toISOString(),
                });
            }

            return reply.send({
                ok: true,
                scenarios: result.scenarios,
                currentPrice: result.currentPrice,
                generatedAt: result.generatedAt,
            });
        } catch (err) {
            return v1HandleError(reply, err);
        }
    });

    // GET /v1/signals/equity-curve — cumulative P&L from all closed signals
    app.get("/signals/equity-curve", {
        schema: {
            tags: ["ML Signals"],
            summary: "Get equity curve from signal history",
            security: [{ bearerAuth: [] }],
        },
        preHandler: requireUser,
    }, async (_req, reply) => {
        try {
            const result = await getEquityCurve();
            return reply.send({ ok: true, ...result });
        } catch (err) {
            return v1HandleError(reply, err);
        }
    });

    // GET /v1/signals/performance — aggregate performance across all pairs
    app.get("/signals/performance", {
        schema: {
            tags: ["ML Signals"],
            summary: "Get aggregate AI signal performance",
            security: [{ bearerAuth: [] }],
        },
        preHandler: requireUser,
    }, async (req, reply) => {
        try {
            const { rows } = await pool.query<{
                total: string;
                wins: string;
                losses: string;
                expired: string;
                avg_confidence: string;
                tp1_hits: string;
                tp2_hits: string;
                tp3_hits: string;
            }>(
                `SELECT
                    COUNT(*) as total,
                    COUNT(*) FILTER (WHERE outcome IN ('tp1','tp2','tp3')) as wins,
                    COUNT(*) FILTER (WHERE outcome = 'sl') as losses,
                    COUNT(*) FILTER (WHERE outcome = 'expired') as expired,
                    COALESCE(AVG(confidence), 0) as avg_confidence,
                    COUNT(tp1_hit_at) as tp1_hits,
                    COUNT(tp2_hit_at) as tp2_hits,
                    COUNT(tp3_hit_at) as tp3_hits
                 FROM ml_signals`,
            );

            const r = rows[0]!;
            const total = Number(r.total);
            const wins = Number(r.wins);
            const losses = Number(r.losses);
            const decided = wins + losses;

            return reply.send({
                ok: true,
                performance: {
                    totalSignals: total,
                    wins,
                    losses,
                    expired: Number(r.expired),
                    winRate: decided > 0 ? Math.round((wins / decided) * 1000) / 1000 : 0,
                    tp1HitRate: total > 0 ? Math.round((Number(r.tp1_hits) / total) * 1000) / 1000 : 0,
                    tp2HitRate: total > 0 ? Math.round((Number(r.tp2_hits) / total) * 1000) / 1000 : 0,
                    tp3HitRate: total > 0 ? Math.round((Number(r.tp3_hits) / total) * 1000) / 1000 : 0,
                    avgConfidence: Math.round(Number(r.avg_confidence) * 10) / 10,
                },
            });
        } catch (err) {
            return v1HandleError(reply, err);
        }
    });
};

export default v1Signals;
