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
});

const equityCurveQuery = z.object({
    from: z.coerce.number().int().optional(),
    to: z.coerce.number().int().optional(),
    limit: z.string().optional(),
    cursor: z.string().optional(),
});

const performanceQuery = z.object({
    from: z.coerce.number().int().optional(),
    to: z.coerce.number().int().optional(),
});

const v1Portfolio: FastifyPluginAsync = async (app) => {
    // GET /v1/portfolio/summary
    app.get("/portfolio/summary", { preHandler: requireUser }, async (req, reply) => {
        try {
            const actor = req.user!;
            const parsed = summaryQuery.safeParse(req.query);
            const q = parsed.success ? parsed.data : {};

            const summary = await getPortfolioSummary(actor.id, q.pairId);
            return reply.send(summary);
        } catch (err) {
            return v1HandleError(reply, err);
        }
    });

    // GET /v1/portfolio/equity
    app.get("/portfolio/equity", { preHandler: requireUser }, async (req, reply) => {
        try {
            const actor = req.user!;
            const parsed = equityCurveQuery.safeParse(req.query);
            const q = parsed.success ? parsed.data : {};

            const limit = parseLimit(q.limit);
            const cursor = decodeCursor<{ ts: number }>(q.cursor);

            const rows = await getEquityCurve(actor.id, q.from, q.to, limit, cursor);

            const page = slicePage(rows, limit, (row) => ({
                ts: Number(row.ts),
            }));

            return reply.send(page);
        } catch (err) {
            return v1HandleError(reply, err);
        }
    });

    // GET /v1/portfolio/performance
    app.get("/portfolio/performance", { preHandler: requireUser }, async (req, reply) => {
        try {
            const actor = req.user!;
            const parsed = performanceQuery.safeParse(req.query);
            const q = parsed.success ? parsed.data : {};

            const perf = await getPerformance(actor.id, q.from, q.to);
            return reply.send(perf);
        } catch (err) {
            return v1HandleError(reply, err);
        }
    });
};

export default v1Portfolio;
