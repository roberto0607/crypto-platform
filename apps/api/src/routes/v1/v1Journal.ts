import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import { requireUser } from "../../auth/requireUser";
import { listClosedTrades, getJournalSummary } from "../../journal/journalRepo";

const journalQuery = z.object({
    pairId: z.string().uuid().optional(),
    direction: z.enum(["LONG", "SHORT"]).optional(),
    pnlSign: z.enum(["positive", "negative"]).optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
});

const summaryQuery = z.object({
    pairId: z.string().uuid().optional(),
});

const v1Journal: FastifyPluginAsync = async (app) => {
    // GET /trades/journal — paginated trade journal
    app.get("/trades/journal", {
        preHandler: requireUser,
        handler: async (req, reply) => {
            const userId = (req as any).user.id;
            const competitionId = req.headers["x-competition-id"] as string | undefined;
            const q = journalQuery.parse(req.query);

            const result = await listClosedTrades({
                userId,
                pairId: q.pairId,
                competitionId: competitionId ?? null,
                direction: q.direction,
                pnlSign: q.pnlSign,
                from: q.from,
                to: q.to,
                cursor: q.cursor,
                limit: q.limit,
            });

            return reply.send({ ok: true, ...result });
        },
    });

    // GET /trades/journal/summary — aggregate stats
    app.get("/trades/journal/summary", {
        preHandler: requireUser,
        handler: async (req, reply) => {
            const userId = (req as any).user.id;
            const competitionId = req.headers["x-competition-id"] as string | undefined;
            const q = summaryQuery.parse(req.query);

            const summary = await getJournalSummary(
                userId,
                competitionId ?? null,
                q.pairId,
            );

            return reply.send({ ok: true, summary });
        },
    });

    // GET /trades/journal/export — CSV download
    app.get("/trades/journal/export", {
        preHandler: requireUser,
        handler: async (req, reply) => {
            const userId = (req as any).user.id;
            const competitionId = req.headers["x-competition-id"] as string | undefined;

            const { trades } = await listClosedTrades({
                userId,
                competitionId: competitionId ?? null,
                limit: 10000,
            });

            const header = "Date,Pair,Direction,Entry Price,Exit Price,Qty,Gross P&L,Fees,Net P&L,Return %,Hold Time (s)\n";
            const rows = trades.map((t: Record<string, unknown>) =>
                [
                    t.exit_at, t.pair_symbol, t.direction,
                    t.entry_avg_price, t.exit_avg_price, t.entry_qty,
                    t.gross_pnl, t.total_fees, t.net_pnl,
                    t.return_pct, t.holding_seconds,
                ].join(",")
            ).join("\n");

            reply.header("Content-Type", "text/csv");
            reply.header("Content-Disposition", "attachment; filename=trade-journal.csv");
            return reply.send(header + rows);
        },
    });
};

export default v1Journal;
