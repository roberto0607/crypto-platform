import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import { requireUser } from "../auth/requireUser";
import { getPositions, getPnlSummary, getEquitySeries } from "../analytics/pnlService";

// ── Zod schemas ──
const positionsQuery = z.object({
    pairId: z.string().uuid().optional(),
});

const equityQuery = z.object({
    from: z.coerce.number().int().optional(),
    to: z.coerce.number().int().optional(),
});

// ── Plugin ──
const analyticsRoutes: FastifyPluginAsync = async (app) => {

    // GET /positions — List user's positions with unrealized PnL
    app.get("/positions", { schema: { tags: ["Portfolio"], summary: "List positions", description: "Returns user's open positions with unrealized PnL.", security: [{ bearerAuth: [] }], querystring: { type: "object", properties: { pairId: { type: "string", format: "uuid" } } }, response: { 200: { type: "object", properties: { ok: { type: "boolean" }, positions: { type: "array", items: { type: "object", additionalProperties: true } } } } } }, preHandler: requireUser }, async (req, reply) => {
        const actor = req.user!;
        const queryParsed = positionsQuery.safeParse(req.query);
        const pairId = queryParsed.success ? queryParsed.data.pairId : undefined;

        const positions = await getPositions(actor.id, pairId);
        return reply.send({ ok: true, positions });
    });

    // GET /pnl/summary — Aggregate PnL across all positions
    app.get("/pnl/summary", { schema: { tags: ["Portfolio"], summary: "PnL summary", description: "Returns aggregate PnL across all positions.", security: [{ bearerAuth: [] }], response: { 200: { type: "object", properties: { ok: { type: "boolean" }, summary: { type: "object", additionalProperties: true } } } } }, preHandler: requireUser }, async (req, reply) => {
        const actor = req.user!;
        const summary = await getPnlSummary(actor.id);
        return reply.send({ ok: true, summary });
    });

    // GET /equity — Equity time series
    app.get("/equity", { schema: { tags: ["Portfolio"], summary: "Equity time series", description: "Returns equity snapshots over time. Supports time range filtering.", security: [{ bearerAuth: [] }], querystring: { type: "object", properties: { from: { type: "integer", description: "Start timestamp (epoch seconds)" }, to: { type: "integer", description: "End timestamp (epoch seconds)" } } }, response: { 200: { type: "object", properties: { ok: { type: "boolean" }, series: { type: "array", items: { type: "object", additionalProperties: true } } } } } }, preHandler: requireUser }, async (req, reply) => {
        const actor = req.user!;
        const queryParsed = equityQuery.safeParse(req.query);
        const from = queryParsed.success ? queryParsed.data.from : undefined;
        const to = queryParsed.success ? queryParsed.data.to : undefined;

        const series = await getEquitySeries(actor.id, from, to);
        return reply.send({ ok: true, series });
    });

    // GET /stats — Combined stats (positions + pnl summary)
    app.get("/stats", { schema: { tags: ["Portfolio"], summary: "Combined stats", description: "Returns positions and PnL summary in a single call.", security: [{ bearerAuth: [] }], response: { 200: { type: "object", properties: { ok: { type: "boolean" }, positions: { type: "array", items: { type: "object", additionalProperties: true } }, summary: { type: "object", additionalProperties: true } } } } }, preHandler: requireUser }, async (req, reply) => {
        const actor = req.user!;
        const [positions, summary] = await Promise.all([
            getPositions(actor.id),
            getPnlSummary(actor.id),
        ]);
        return reply.send({ ok: true, positions, summary });
    });
};

export default analyticsRoutes;
