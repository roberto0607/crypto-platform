import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import { requireUser } from "../auth/requireUser";
import { getPositions, getPnlSummary, getEquitySeries } from "../analytics/pnlService";
import type { PositionRow } from "../analytics/positionRepo";
import type { PositionWithPnl } from "../analytics/pnlService";
import { getActiveMatchIdForUser } from "../competitions/matchService";
import { getSnapshotForUser } from "../replay/replayEngine";
import { pool } from "../db/pool";
import { D, toFixed8 } from "../utils/decimal";

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

    // GET /positions — List user's positions with unrealized PnL.
    //
    // Scope: follows the user's active match state, not the raw table.
    //   - In a match → only that match's scoped rows. Free-play rows hidden.
    //   - Not in a match → only unscoped (free-play) rows. Match-scoped
    //     rows from a previous match stay with the match, not the user.
    //
    // Filters out base_qty = 0 rows (flat / fully-closed aggregates should
    // not render as open positions).
    //
    // We do a bespoke query here instead of extending `getPositions` — the
    // shared helper is still used by portfolioService and pnlService for
    // aggregate-scope reads, and widening its signature would force scope
    // decisions on those callers. The trade-off is ~20 lines of duplicated
    // unrealized-PnL attach logic, which is acceptable for route isolation.
    app.get("/positions", { schema: { tags: ["Portfolio"], summary: "List positions", description: "Returns user's open positions with unrealized PnL.", security: [{ bearerAuth: [] }], querystring: { type: "object", properties: { pairId: { type: "string", format: "uuid" } } }, response: { 200: { type: "object", properties: { ok: { type: "boolean" }, positions: { type: "array", items: { type: "object", additionalProperties: true } } } } } }, preHandler: requireUser }, async (req, reply) => {
        const actor = req.user!;
        const queryParsed = positionsQuery.safeParse(req.query);
        const pairId = queryParsed.success ? queryParsed.data.pairId : undefined;

        const activeMatchId = await getActiveMatchIdForUser(actor.id);

        const conditions: string[] = [`user_id = $1`, `base_qty <> 0`];
        const params: (string | null)[] = [actor.id];

        if (activeMatchId) {
            // In-match — show only the current match's rows.
            params.push(activeMatchId);
            conditions.push(`match_id = $${params.length}`);
        } else {
            // Free-play — exclude any match- or competition-scoped rows.
            conditions.push(`match_id IS NULL`);
            conditions.push(`competition_id IS NULL`);
        }

        if (pairId) {
            params.push(pairId);
            conditions.push(`pair_id = $${params.length}`);
        }

        const { rows } = await pool.query<PositionRow>(
            `SELECT user_id, pair_id, base_qty, avg_entry_price,
                    realized_pnl_quote, fees_paid_quote, updated_at
             FROM positions
             WHERE ${conditions.join(" AND ")}
             ORDER BY updated_at DESC`,
            params,
        );

        // Attach unrealized PnL using the same snapshot cascade as getPositions.
        const positions: PositionWithPnl[] = [];
        for (const pos of rows) {
            const baseQty = D(pos.base_qty);
            const snapshot = await getSnapshotForUser(actor.id, pos.pair_id);
            const currentPrice = D(snapshot.last);
            const avgEntry = D(pos.avg_entry_price);
            const unrealized = baseQty.mul(currentPrice.minus(avgEntry));
            positions.push({
                ...pos,
                unrealized_pnl_quote: toFixed8(unrealized),
                current_price: toFixed8(currentPrice),
            });
        }

        req.log.info(
            {
                userId: actor.id,
                scope: activeMatchId ? "match" : "free-play",
                matchId: activeMatchId,
                count: positions.length,
            },
            "positions_listed",
        );

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
