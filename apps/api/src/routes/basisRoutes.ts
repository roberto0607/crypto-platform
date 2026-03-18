import type { FastifyPluginAsync } from "fastify";
import { getCurrentBasis } from "../market/perpetualBasisService";

const basisRoutes: FastifyPluginAsync = async (app) => {
    app.get("/market/basis", {
        schema: {
            tags: ["Market"],
            summary: "Get BTC spot vs perpetual futures basis",
            description: "Returns real-time basis (spot-perp spread), funding rate, crowding signal, and 24h history.",
        },
    }, async (_req, reply) => {
        const basis = getCurrentBasis();
        if (!basis) {
            return reply.code(503).send({ ok: false, error: "basis_not_ready", message: "Waiting for first data fetch" });
        }
        return reply.send({ ok: true, ...basis });
    });
};

export default basisRoutes;
