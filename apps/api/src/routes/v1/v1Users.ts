import type { FastifyPluginAsync } from "fastify";
import { requireUser } from "../../auth/requireUser";
import { searchPlayers } from "../../auth/userRepo";
import { config } from "../../config";
import { AppError } from "../../errors/AppError";
import { v1HandleError } from "../../http/v1Error";

const MIN_QUERY_LENGTH = 2;
const SEARCHABLE = /^[a-zA-Z0-9_]+$/;

const v1Users: FastifyPluginAsync = async (app) => {
    // GET /v1/users/search — find players by username prefix
    app.get("/users/search", {
        schema: {
            tags: ["Users"],
            summary: "Search players by username",
            description: "**Rate limit:** 60 requests per minute per user.\n\nCase-insensitive username prefix match, at most 10 results. Public fields only. Excludes the caller, system accounts and test-only email domains.",
            security: [{ bearerAuth: [] }],
            querystring: {
                type: "object",
                properties: { q: { type: "string", description: "Username prefix, at least 2 characters" } },
            },
            response: {
                // The serializer drops anything not listed, so a column added
                // to the query can't reach a client by accident.
                200: {
                    type: "object",
                    properties: {
                        ok: { type: "boolean", const: true },
                        users: {
                            type: "array",
                            items: {
                                type: "object",
                                properties: {
                                    id: { type: "string", format: "uuid" },
                                    username: { type: "string" },
                                    tier: { type: "string" },
                                    elo: { type: "integer" },
                                    wins: { type: "integer" },
                                    losses: { type: "integer" },
                                },
                            },
                        },
                    },
                },
            },
        },
        config: { rateLimit: { max: 60, timeWindow: 60_000 } },
        preHandler: requireUser,
    }, async (req, reply) => {
        try {
            const q = ((req.query as { q?: string }).q ?? "").trim();
            if (q.length < MIN_QUERY_LENGTH) throw new AppError("invalid_input");
            if (!SEARCHABLE.test(q)) return reply.send({ ok: true, users: [] });

            const users = await searchPlayers(q, [req.user!.id, config.botUserId, config.riskAgentBotUserId]);
            return reply.send({ ok: true, users });
        } catch (err) {
            return v1HandleError(reply, err);
        }
    });
};

export default v1Users;
