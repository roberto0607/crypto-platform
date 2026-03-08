import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { pool } from "../../db/pool.js";
import { requireUser } from "../../auth/requireUser.js";
import { getUserTier, getUserTierHistory } from "../../competitions/tierRepo.js";
import { getUserBadges } from "../../competitions/badgeRepo.js";


const displayNameSchema = z.object({
    displayName: z.string()
        .min(3, "Display name must be at least 3 characters")
        .max(30, "Display name must be at most 30 characters")
        .regex(/^[a-zA-Z0-9_]+$/, "Display name can only contain letters, numbers, and underscores"),
});

const v1Profile: FastifyPluginAsync = async (app) => {
    // PATCH /v1/profile — Update display name
    app.patch("/profile", {
        schema: {
            tags: ["Profile"],
            summary: "Update user profile",
            description: "Update the authenticated user's display name. 3-30 chars, alphanumeric + underscores.",
            security: [{ bearerAuth: [] }],
            body: {
                type: "object",
                required: ["displayName"],
                properties: {
                    displayName: {
                        type: "string",
                        minLength: 3,
                        maxLength: 30,
                        pattern: "^[a-zA-Z0-9_]+$",
                    },
                },
            },
            response: {
                200: {
                    type: "object",
                    properties: {
                        ok: { type: "boolean", const: true },
                        displayName: { type: "string" },
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
                409: {
                    type: "object",
                    properties: {
                        ok: { type: "boolean", const: false },
                        error: { type: "string" },
                    },
                },
            },
        },
        preHandler: requireUser,
    }, async (req, reply) => {
        const parsed = displayNameSchema.safeParse(req.body);
        if (!parsed.success) {
            return reply.code(400).send({
                ok: false,
                error: "invalid_input",
                details: parsed.error.flatten(),
            });
        }

        const userId = req.user!.id;
        const { displayName } = parsed.data;

        try {
            await pool.query(
                `UPDATE users SET display_name = $1 WHERE id = $2`,
                [displayName, userId],
            );

            return reply.send({ ok: true, displayName });
        } catch (err: any) {
            // If unique constraint on display_name exists:
            if (err?.code === "23505") {
                return reply.code(409).send({
                    ok: false,
                    error: "display_name_taken",
                });
            }
            throw err;
        }
    });

    // GET /v1/profile — Get user profile
    app.get("/profile", {
        schema: {
            tags: ["Profile"],
            summary: "Get user profile",
            security: [{ bearerAuth: [] }],
            response: {
                200: {
                    type: "object",
                    properties: {
                        ok: { type: "boolean", const: true },
                        profile: {
                            type: "object",
                            properties: {
                                id: { type: "string" },
                                email: { type: "string" },
                                displayName: { type: "string", nullable: true },
                                role: { type: "string" },
                            },
                        },
                    },
                },
            },
        },
        preHandler: requireUser,
    }, async (req, reply) => {
        const userId = req.user!.id;
        const { rows } = await pool.query<{
            id: string;
            email: string;
            display_name: string | null;
            role: string;
        }>(
            `SELECT id, email, display_name, role FROM users WHERE id = $1`,
            [userId],
        );

        const user = rows[0];
        return reply.send({
            ok: true,
            profile: {
                id: user.id,
                email: user.email,
                displayName: user.display_name,
                role: user.role,
            },
        });
    });
    // GET /v1/profile/tier — Get user's tier and history
    app.get("/profile/tier", {
        schema: {
            tags: ["Profile"],
            summary: "Get user tier",
            description: "Returns the authenticated user's current tier and tier change history.",
            security: [{ bearerAuth: [] }],
        },
        preHandler: requireUser,
    }, async (req, reply) => {
        const userId = req.user!.id;
        const tier = await getUserTier(userId);
        const history = await getUserTierHistory(userId, 20);
        return reply.send({ ok: true, tier, history });
    });

    // GET /v1/profile/badges — Get user's badges
    app.get("/profile/badges", {
        schema: {
            tags: ["Profile"],
            summary: "Get user badges",
            description: "Returns all badges earned by the authenticated user.",
            security: [{ bearerAuth: [] }],
        },
        preHandler: requireUser,
    }, async (req, reply) => {
        const userId = req.user!.id;
        const badges = await getUserBadges(userId);
        return reply.send({ ok: true, badges });
    });

    // GET /v1/users/:id/badges — Public: get badges for any user
    app.get("/users/:id/badges", {
        schema: {
            tags: ["Profile"],
            summary: "Get user badges (public)",
            description: "Returns all badges for a given user. No authentication required.",
            params: {
                type: "object",
                properties: { id: { type: "string", format: "uuid" } },
                required: ["id"],
            },
        },
    }, async (req, reply) => {
        const { id } = req.params as { id: string };
        const badges = await getUserBadges(id);
        return reply.send({ ok: true, badges });
    });
};

export default v1Profile;
