import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import { requireUser } from "../auth/requireUser";
import { getSnapshotForUser} from "../replay/replayEngine";

const pairIdParams = z.object({ id: z.string().uuid() });

const marketRoutes: FastifyPluginAsync = async (app) => {

    //GET  /pairs/:id/snapshot - Current price snapshot (live, replay, or fallback)
    app.get("/pairs/:id/snapshot", { schema: { tags: ["Pairs"], summary: "Price snapshot", description: "Returns the current price snapshot for a pair (live, replay, or fallback).", security: [{ bearerAuth: [] }], params: { type: "object", required: ["id"], properties: { id: { type: "string", format: "uuid" } } }, response: { 200: { type: "object", properties: { ok: { type: "boolean" }, snapshot: { type: "object", additionalProperties: true } } }, 400: { type: "object", properties: { ok: { type: "boolean" }, error: { type: "string" } } } } }, preHandler: requireUser }, async (req, reply) => {
        const paramsParsed = pairIdParams.safeParse(req.params);
        if (!paramsParsed.success) {
            return reply.code(400).send({ ok: false, error: "invalid_input", details: paramsParsed.error.flatten() });
        }

        const actor = req.user!;
        const snapshot = await getSnapshotForUser(actor.id, paramsParsed.data.id);

        return reply.send({ ok: true, snapshot });
    });
};

export default marketRoutes;