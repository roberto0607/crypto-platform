import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import { requireUser } from "../../auth/requireUser";
import { v1HandleError } from "../../http/v1Error";
import { decodeCursor, parseLimit, slicePage } from "../../http/pagination";
import { getEquitySeriesPaginated } from "../../analytics/pnlService";

const equityQuery = z.object({
    from: z.coerce.number().int().optional(),
    to: z.coerce.number().int().optional(),
    limit: z.string().optional(),
    cursor: z.string().optional(),
});

const v1Equity: FastifyPluginAsync = async (app) => {
    app.get("/equity", {
        schema: {
            tags: ["Portfolio"],
            summary: "Equity series (paginated)",
            description: "Returns paginated equity snapshots over time. Supports time range filtering.",
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
                        data: { type: "array", items: { type: "object", additionalProperties: true } },
                        nextCursor: { type: "string", nullable: true },
                    },
                },
            },
        },
        preHandler: requireUser,
    }, async (req, reply) => {
        try {
            const actor = req.user!;
            const queryParsed = equityQuery.safeParse(req.query);
            const q = queryParsed.success ? queryParsed.data : {};

            const limit = parseLimit(q.limit);
            const cursor = decodeCursor<{ ts: number }>(q.cursor);

            const rows = await getEquitySeriesPaginated(
                actor.id,
                q.from,
                q.to,
                limit,
                cursor,
            );

            const page = slicePage(rows, limit, (row) => ({
                ts: Number(row.ts),
            }));

            return reply.send(page);
        } catch (err) {
            return v1HandleError(reply, err);
        }
    });
};

export default v1Equity;
