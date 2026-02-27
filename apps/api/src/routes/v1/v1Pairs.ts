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
    app.get("/pairs", { preHandler: requireUser }, async (req, reply) => {
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
