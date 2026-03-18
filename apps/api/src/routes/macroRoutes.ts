import type { FastifyPluginAsync } from "fastify";
import { getCurrentMacro } from "../market/macroCorrelationService";

const macroRoutes: FastifyPluginAsync = async (app) => {
    app.get("/market/macro", {
        schema: {
            tags: ["Market"],
            summary: "Get macro correlation data (DXY + QQQ vs BTC)",
            description: "Returns Pearson correlations, macro regime detection, DXY trend/impact, and rolling history.",
        },
    }, async (_req, reply) => {
        const macro = getCurrentMacro();
        if (!macro) {
            return reply.code(503).send({ ok: false, error: "macro_not_ready", message: "Waiting for first data fetch" });
        }
        return reply.send({ ok: true, ...macro });
    });
};

export default macroRoutes;
