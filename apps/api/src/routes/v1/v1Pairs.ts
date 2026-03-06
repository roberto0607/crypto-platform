import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import { requireUser } from "../../auth/requireUser";
import { v1HandleError } from "../../http/v1Error";
import { parseLimit } from "../../http/pagination";
import { listActivePairsLimited } from "../../trading/pairRepo";

const pairsQuery = z.object({
    limit: z.string().optional(),
});

const v1Pairs: FastifyPluginAsync = async (app) => {
    app.get("/pairs", {
        schema: {
            tags: ["Pairs"],
            summary: "List trading pairs (v1 paginated)",
            description: "Returns active trading pairs with optional limit.",
            security: [{ bearerAuth: [] }],
            querystring: {
                type: "object",
                properties: {
                    limit: { type: "string", description: "Max results to return (default 50, max 100)" },
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

            const limit = parseLimit(q.limit);
            const pairs = await listActivePairsLimited(limit);

            return reply.send({ data: pairs, nextCursor: null });
        } catch (err) {
            return v1HandleError(reply, err);
        }
    });
};

export default v1Pairs;
