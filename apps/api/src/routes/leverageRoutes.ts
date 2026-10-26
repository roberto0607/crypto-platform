import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import { requireUser } from "../auth/requireUser";
import { handleError } from "../http/handleError";
import { getActiveMatchIdForUser } from "../competitions/matchService";
import { assertTradablePairId } from "../market/marketSymbols";
import { getLeverageInfo } from "../trading/leverageInfo";

const query = z.object({ pairId: z.string().uuid() });

/**
 * GET /leverage?pairId= — the model and leverage cap the user's next order on
 * this pair would get (trading/leverageInfo.ts), in the scope POST /orders
 * would use: the active match (resolved here), else X-Competition-Id, else
 * free-play. The order panel's only source for showing leverage.
 */
const leverageRoutes: FastifyPluginAsync = async (app) => {
    app.get("/leverage", {
        schema: {
            tags: ["Trading"],
            summary: "Leverage available on a pair",
            description: "The margin model (SPOT / ISOLATED) and leverage cap the caller's next order on the pair would get, the pair's maintenance margin, the open position's leverage, and any resting order of the other model that blocks trading.",
            security: [{ bearerAuth: [] }],
            querystring: {
                type: "object",
                required: ["pairId"],
                properties: { pairId: { type: "string", format: "uuid" } },
            },
            response: {
                200: {
                    type: "object",
                    properties: {
                        ok: { type: "boolean", const: true },
                        pairId: { type: "string" },
                        enabled: { type: "boolean" },
                        marginMode: { type: "string", enum: ["SPOT", "ISOLATED"] },
                        cap: { type: "number" },
                        mmrBps: { type: "number" },
                        positionLeverage: { type: ["string", "null"] },
                        blockedBy: { type: ["string", "null"] },
                        scope: {
                            type: "object",
                            properties: {
                                competitionId: { type: ["string", "null"] },
                                matchId: { type: ["string", "null"] },
                            },
                        },
                    },
                },
                400: {
                    type: "object",
                    properties: {
                        ok: { type: "boolean", const: false },
                        error: { type: "string" },
                        details: { type: "object", additionalProperties: true },
                    },
                },
            },
        },
        preHandler: requireUser,
    }, async (req, reply) => {
        const parsed = query.safeParse(req.query);
        if (!parsed.success) {
            return reply.code(400).send({ ok: false, error: "invalid_input", details: parsed.error.flatten() });
        }
        try {
            const { pairId } = parsed.data;
            await assertTradablePairId(pairId);
            const userId = req.user!.id;
            const matchId = await getActiveMatchIdForUser(userId);
            const competitionId = matchId ? null : ((req.headers["x-competition-id"] as string | undefined) ?? null);
            const scope = { competitionId, matchId };
            const info = await getLeverageInfo(userId, pairId, scope);
            return reply.send({ ok: true, pairId, ...info, scope });
        } catch (err) {
            return handleError(reply, err);
        }
    });
};

export default leverageRoutes;
