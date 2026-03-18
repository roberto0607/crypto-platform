import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import { requireUser } from "../../auth/requireUser";
import { v1HandleError } from "../../http/v1Error";
import { decodeCursor, parseLimit, slicePage } from "../../http/pagination";
import {
    getPortfolioSummary,
    getEquityCurve,
    getPerformance,
} from "../../portfolio/portfolioService";

const summaryQuery = z.object({
    pairId: z.string().uuid().optional(),
    competitionId: z.string().uuid().optional(),
});

const equityCurveQuery = z.object({
    from: z.coerce.number().int().optional(),
    to: z.coerce.number().int().optional(),
    limit: z.string().optional(),
    cursor: z.string().optional(),
    competitionId: z.string().uuid().optional(),
});

const performanceQuery = z.object({
    from: z.coerce.number().int().optional(),
    to: z.coerce.number().int().optional(),
    competitionId: z.string().uuid().optional(),
});

const v1Portfolio: FastifyPluginAsync = async (app) => {
    // GET /v1/portfolio/summary
    app.get("/portfolio/summary", {
        schema: {
            tags: ["Portfolio"],
            summary: "Portfolio summary",
            description: "Returns portfolio summary including total equity, unrealized PnL, and open positions. Optionally filter by pair.",
            security: [{ bearerAuth: [] }],
            querystring: {
                type: "object",
                properties: {
                    pairId: { type: "string", format: "uuid", description: "Filter by trading pair" },
                },
            },
            response: { 200: { type: "object", additionalProperties: true } },
        },
        preHandler: requireUser,
    }, async (req, reply) => {
        try {
            const actor = req.user!;
            const parsed = summaryQuery.safeParse(req.query);
            const q = parsed.success ? parsed.data : {};

            const summary = await getPortfolioSummary(actor.id, q.pairId, q.competitionId);
            return reply.send({ summary });
        } catch (err) {
            return v1HandleError(reply, err);
        }
    });

    // GET /v1/portfolio/equity
    app.get("/portfolio/equity", {
        schema: {
            tags: ["Portfolio"],
            summary: "Equity curve (paginated)",
            description: "Returns equity snapshots over time. Supports time range filtering and cursor-based pagination.",
            security: [{ bearerAuth: [] }],
            querystring: {
                type: "object",
                properties: {
                    from: { type: "integer", description: "Start timestamp (epoch seconds)" },
                    to: { type: "integer", description: "End timestamp (epoch seconds)" },
                    limit: { type: "string" },
                    cursor: { type: "string" },
                },
            },
            response: {
                200: {
                    type: "object",
                    properties: {
                        snapshots: { type: "array", items: { type: "object", additionalProperties: true } },
                        nextCursor: { type: "string", nullable: true },
                    },
                },
            },
        },
        preHandler: requireUser,
    }, async (req, reply) => {
        try {
            const actor = req.user!;
            const parsed = equityCurveQuery.safeParse(req.query);
            const q = parsed.success ? parsed.data : {};

            const limit = parseLimit(q.limit);
            const cursor = decodeCursor<{ ts: number }>(q.cursor);

            const rows = await getEquityCurve(actor.id, q.from, q.to, limit, cursor, q.competitionId);

            const page = slicePage(rows, limit, (row) => ({
                ts: Number(row.ts),
            }));

            return reply.send({ snapshots: page.data, nextCursor: page.nextCursor });
        } catch (err) {
            return v1HandleError(reply, err);
        }
    });

    // GET /v1/portfolio/performance
    app.get("/portfolio/performance", {
        schema: {
            tags: ["Portfolio"],
            summary: "Portfolio performance metrics",
            description: "Returns performance metrics (win rate, Sharpe ratio, max drawdown, etc.) over an optional time range.",
            security: [{ bearerAuth: [] }],
            querystring: {
                type: "object",
                properties: {
                    from: { type: "integer", description: "Start timestamp (epoch seconds)" },
                    to: { type: "integer", description: "End timestamp (epoch seconds)" },
                },
            },
            response: { 200: { type: "object", additionalProperties: true } },
        },
        preHandler: requireUser,
    }, async (req, reply) => {
        try {
            const actor = req.user!;
            const parsed = performanceQuery.safeParse(req.query);
            const q = parsed.success ? parsed.data : {};

            const perf = await getPerformance(actor.id, q.from, q.to, q.competitionId);
            return reply.send({ performance: perf });
        } catch (err) {
            return v1HandleError(reply, err);
        }
    });
};

export default v1Portfolio;
