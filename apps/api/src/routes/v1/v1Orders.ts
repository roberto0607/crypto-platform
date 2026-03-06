import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import { requireUser } from "../../auth/requireUser";
import { v1HandleError } from "../../http/v1Error";
import { decodeCursor, parseLimit, slicePage } from "../../http/pagination";
import { listOrdersByUserIdPaginated } from "../../trading/orderRepo";

const listOrdersQuery = z.object({
    pairId: z.string().uuid().optional(),
    status: z.string().optional(),
    limit: z.string().optional(),
    cursor: z.string().optional(),
});

const v1Orders: FastifyPluginAsync = async (app) => {
    app.get("/orders", {
        schema: {
            tags: ["Trading"],
            summary: "List orders (paginated)",
            description: "Returns paginated orders for the authenticated user. Supports cursor-based pagination and filtering by pair or status.",
            security: [{ bearerAuth: [] }],
            querystring: {
                type: "object",
                properties: {
                    pairId: { type: "string", format: "uuid", description: "Filter by trading pair" },
                    status: { type: "string", description: "Filter by order status" },
                    limit: { type: "string", description: "Page size (default 50, max 100)" },
                    cursor: { type: "string", description: "Cursor from previous page's nextCursor" },
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
            const queryParsed = listOrdersQuery.safeParse(req.query);
            const q = queryParsed.success ? queryParsed.data : {};

            const limit = parseLimit(q.limit);
            const cursor = decodeCursor<{ ca: string; id: string }>(q.cursor);

            const rows = await listOrdersByUserIdPaginated(
                actor.id,
                { pairId: q.pairId, status: q.status },
                limit,
                cursor,
            );

            const page = slicePage(rows, limit, (row) => ({
                ca: row.created_at,
                id: row.id,
            }));

            return reply.send(page);
        } catch (err) {
            return v1HandleError(reply, err);
        }
    });
};

export default v1Orders;
