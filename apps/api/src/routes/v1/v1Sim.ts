import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import { requireUser } from "../../auth/requireUser";
import { requireRole } from "../../auth/requireRole";
import { v1HandleError } from "../../http/v1Error";
import { AppError } from "../../errors/AppError";
import {
    getSimulationConfigForUser,
    upsertSimulationConfig,
    resolveSimulationConfig,
} from "../../sim/simConfigRepo";
import { computeMarketExecution } from "../../sim/slippageModel";
import { computeAvailableLiquidity } from "../../sim/liquidityModel";
import { resolveSnapshot } from "../../trading/phase6OrderService";
import { pool } from "../../db/pool";
import { D, toFixed8 } from "../../utils/decimal";

const simConfigSchema = z.object({
    base_spread_bps: z.number().min(0),
    base_slippage_bps: z.number().min(0),
    impact_bps_per_10k_quote: z.number().min(0),
    liquidity_quote_per_tick: z.number().min(0),
    volatility_widening_k: z.number().min(0),
});

const putConfigBody = z.object({
    userId: z.string().uuid().nullable().optional(),
    pairId: z.string().uuid().nullable().optional(),
    config: simConfigSchema,
});

const quoteQuery = z.object({
    pairId: z.string().uuid(),
    side: z.enum(["BUY", "SELL"]),
    qty: z.string().regex(/^\d+(\.\d{1,8})?$/),
});

const v1Sim: FastifyPluginAsync = async (app) => {
    // GET /v1/sim/config
    app.get("/sim/config", {
        schema: {
            tags: ["Trading"],
            summary: "Get simulation config",
            description: "Returns the effective simulation configuration for the authenticated user, optionally for a specific pair.",
            security: [{ bearerAuth: [] }],
            querystring: {
                type: "object",
                properties: {
                    pairId: { type: "string", format: "uuid", description: "Optional pair-specific config" },
                },
            },
            response: { 200: { type: "object", additionalProperties: true } },
        },
        preHandler: requireUser,
    }, async (req, reply) => {
        try {
            const actor = req.user!;
            const query = req.query as { pairId?: string };
            const config = await getSimulationConfigForUser(actor.id, query.pairId);
            return reply.send(config);
        } catch (err) {
            return v1HandleError(reply, err);
        }
    });

    // PUT /v1/sim/config (ADMIN only)
    app.put(
        "/sim/config",
        {
            schema: {
                tags: ["Admin"],
                summary: "Update simulation config",
                description: "Sets simulation parameters globally or per-user/per-pair. Requires ADMIN role.",
                security: [{ bearerAuth: [] }],
                body: {
                    type: "object",
                    required: ["config"],
                    properties: {
                        userId: { type: "string", format: "uuid", nullable: true },
                        pairId: { type: "string", format: "uuid", nullable: true },
                        config: {
                            type: "object",
                            properties: {
                                base_spread_bps: { type: "number" },
                                base_slippage_bps: { type: "number" },
                                impact_bps_per_10k_quote: { type: "number" },
                                liquidity_quote_per_tick: { type: "number" },
                                volatility_widening_k: { type: "number" },
                            },
                        },
                    },
                },
                response: {
                    200: { type: "object", properties: { ok: { type: "boolean" } } },
                    400: { type: "object", additionalProperties: true },
                },
            },
            preHandler: [requireUser, requireRole("ADMIN")],
        },
        async (req, reply) => {
            try {
                const parsed = putConfigBody.safeParse(req.body);
                if (!parsed.success) {
                    throw new AppError("invalid_input", parsed.error.flatten());
                }
                const { userId, pairId, config } = parsed.data;
                await upsertSimulationConfig(
                    userId ?? null,
                    pairId ?? null,
                    config
                );
                return reply.send({ ok: true });
            } catch (err) {
                return v1HandleError(reply, err);
            }
        }
    );

    // GET /v1/sim/quote
    app.get("/sim/quote", {
        schema: {
            tags: ["Trading"],
            summary: "Get simulation quote",
            description: "Simulates a market order execution and returns estimated price, slippage, and available liquidity.",
            security: [{ bearerAuth: [] }],
            querystring: {
                type: "object",
                required: ["pairId", "side", "qty"],
                properties: {
                    pairId: { type: "string", format: "uuid" },
                    side: { type: "string", enum: ["BUY", "SELL"] },
                    qty: { type: "string", pattern: "^\\d+(\\.\\d{1,8})?$" },
                },
            },
            response: {
                200: {
                    type: "object",
                    properties: {
                        executable: { type: "boolean" },
                        estimatedPrice: { type: "string" },
                        slippage_bps: { type: "string" },
                        requestedNotional: { type: "string" },
                        availableLiquidity: { type: "string" },
                    },
                },
            },
        },
        preHandler: requireUser,
    }, async (req, reply) => {
        try {
            const actor = req.user!;
            const parsed = quoteQuery.safeParse(req.query);
            if (!parsed.success) {
                throw new AppError("invalid_input", parsed.error.flatten());
            }
            const { pairId, side, qty } = parsed.data;

            const snapshot = await resolveSnapshot(actor.id, pairId);
            const simConfig = await resolveSimulationConfig(actor.id, pairId);

            const { rows: candleRows } = await pool.query<{
                volume: string; high: string; low: string;
            }>(
                `SELECT volume, high, low FROM candles
                 WHERE pair_id = $1 AND ts <= $2
                 ORDER BY ts DESC LIMIT 1`,
                [pairId, snapshot.ts]
            );
            const candle = candleRows[0] ?? null;

            const simResult = computeMarketExecution(
                snapshot,
                side,
                qty,
                simConfig,
                candle?.volume ?? null,
                candle?.high ?? null,
                candle?.low ?? null
            );

            if (!simResult) {
                const availLiq = computeAvailableLiquidity(
                    simConfig, candle?.volume ?? null, snapshot.last
                );
                const reqNotional = toFixed8(D(qty).mul(D(snapshot.last)));
                return reply.send({
                    executable: false,
                    estimatedPrice: "0.00000000",
                    slippage_bps: "0.00000000",
                    requestedNotional: reqNotional,
                    availableLiquidity: availLiq,
                });
            }

            return reply.send({
                executable: true,
                estimatedPrice: simResult.execPrice,
                slippage_bps: simResult.slippage_bps,
                requestedNotional: simResult.requestedNotional,
                availableLiquidity: simResult.availableLiquidityQuote,
            });
        } catch (err) {
            return v1HandleError(reply, err);
        }
    });
};

export default v1Sim;
