import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requireUser } from "../../auth/requireUser";
import { requireRole } from "../../auth/requireRole";
import { v1HandleError } from "../../http/v1Error";
import {
    createCompetition,
    findCompetitionById,
    listCompetitions,
    lockCompetitionForUpdate,
    updateCompetitionStatus,
} from "../../competitions/competitionRepo";
import {
    joinCompetition,
    withdrawFromCompetition,
} from "../../competitions/competitionService";
import { getLeaderboard } from "../../competitions/leaderboardRepo";
import {
    listUserCompetitions,
    updateParticipantStatus,
    findParticipant,
} from "../../competitions/participantRepo";
import { pool } from "../../db/pool";
import { AppError } from "../../errors/AppError";

const createCompetitionBody = z.object({
    name: z.string().min(3).max(100),
    description: z.string().max(1000).optional(),
    startAt: z.string().datetime(),
    endAt: z.string().datetime(),
    startingBalanceUsd: z.string().regex(/^\d+(\.\d{1,8})?$/).optional(),
    maxParticipants: z.number().int().min(2).max(10000).optional(),
    pairsAllowed: z.union([z.literal("all"), z.array(z.string().uuid())]).optional(),
});

const v1Competitions: FastifyPluginAsync = async (app) => {

    // ═══ Public routes ═══

    // GET /competitions — list (filtered, paginated)
    app.get("/competitions", {
        schema: {
            tags: ["Competitions"],
            summary: "List competitions",
            description: "Returns paginated list of competitions. Optionally filter by status.",
            querystring: {
                type: "object",
                properties: {
                    status: { type: "string", description: "Filter by status (UPCOMING, ACTIVE, ENDED, CANCELLED)" },
                    limit: { type: "string", description: "Page size (default 50)" },
                    offset: { type: "string", description: "Offset (default 0)" },
                },
            },
            response: {
                200: {
                    type: "object",
                    properties: {
                        data: { type: "array", items: { type: "object", additionalProperties: true } },
                        total: { type: "number" },
                    },
                },
            },
        },
    }, async (req, reply) => {
        try {
            const query = req.query as { status?: string; limit?: string; offset?: string };
            const result = await listCompetitions({
                status: query.status,
                limit: query.limit ? parseInt(query.limit) : undefined,
                offset: query.offset ? parseInt(query.offset) : undefined,
            });
            return reply.send({ data: result.competitions, total: result.total });
        } catch (err) {
            return v1HandleError(reply, err);
        }
    });

    // GET /competitions/me — user's competitions (must be before :id)
    app.get("/competitions/me", {
        schema: {
            tags: ["Competitions"],
            summary: "My competitions",
            description: "Returns all competitions the authenticated user has joined.",
            security: [{ bearerAuth: [] }],
            response: {
                200: {
                    type: "object",
                    properties: {
                        data: { type: "array", items: { type: "object", additionalProperties: true } },
                    },
                },
            },
        },
        preHandler: requireUser,
    }, async (req, reply) => {
        try {
            const data = await listUserCompetitions(req.user!.id);
            return reply.send({ data });
        } catch (err) {
            return v1HandleError(reply, err);
        }
    });

    // GET /competitions/:id — detail
    app.get("/competitions/:id", {
        schema: {
            tags: ["Competitions"],
            summary: "Get competition",
            description: "Returns details for a single competition.",
            params: {
                type: "object",
                properties: { id: { type: "string", format: "uuid" } },
                required: ["id"],
            },
            response: {
                200: {
                    type: "object",
                    properties: {
                        data: { type: "object", additionalProperties: true },
                    },
                },
            },
        },
    }, async (req, reply) => {
        try {
            const { id } = req.params as { id: string };
            const comp = await findCompetitionById(id);
            if (!comp) throw new AppError("competition_not_found");
            return reply.send({ data: comp });
        } catch (err) {
            return v1HandleError(reply, err);
        }
    });

    // GET /competitions/:id/leaderboard
    app.get("/competitions/:id/leaderboard", {
        schema: {
            tags: ["Competitions"],
            summary: "Competition leaderboard",
            description: "Returns cached leaderboard for a competition.",
            params: {
                type: "object",
                properties: { id: { type: "string", format: "uuid" } },
                required: ["id"],
            },
            querystring: {
                type: "object",
                properties: {
                    limit: { type: "string", description: "Page size (default 100)" },
                    offset: { type: "string", description: "Offset (default 0)" },
                },
            },
            response: {
                200: {
                    type: "object",
                    properties: {
                        data: { type: "array", items: { type: "object", additionalProperties: true } },
                    },
                },
            },
        },
    }, async (req, reply) => {
        try {
            const { id } = req.params as { id: string };
            const query = req.query as { limit?: string; offset?: string };
            const data = await getLeaderboard(
                id,
                query.limit ? parseInt(query.limit) : undefined,
                query.offset ? parseInt(query.offset) : undefined,
            );
            return reply.send({ data });
        } catch (err) {
            return v1HandleError(reply, err);
        }
    });

    // ═══ Authenticated user routes ═══

    // POST /competitions/:id/join
    app.post("/competitions/:id/join", {
        schema: {
            tags: ["Competitions"],
            summary: "Join competition",
            description: "Join a competition. Creates isolated wallets and credits starting balance.",
            security: [{ bearerAuth: [] }],
            params: {
                type: "object",
                properties: { id: { type: "string", format: "uuid" } },
                required: ["id"],
            },
            response: {
                200: {
                    type: "object",
                    properties: { ok: { type: "boolean" } },
                },
            },
        },
        preHandler: requireUser,
    }, async (req, reply) => {
        try {
            const { id } = req.params as { id: string };
            await joinCompetition(req.user!.id, id);
            return reply.send({ ok: true });
        } catch (err) {
            return v1HandleError(reply, err);
        }
    });

    // POST /competitions/:id/withdraw
    app.post("/competitions/:id/withdraw", {
        schema: {
            tags: ["Competitions"],
            summary: "Withdraw from competition",
            description: "Withdraw from a competition. Cancels open orders and marks participant as withdrawn.",
            security: [{ bearerAuth: [] }],
            params: {
                type: "object",
                properties: { id: { type: "string", format: "uuid" } },
                required: ["id"],
            },
            response: {
                200: {
                    type: "object",
                    properties: { ok: { type: "boolean" } },
                },
            },
        },
        preHandler: requireUser,
    }, async (req, reply) => {
        try {
            const { id } = req.params as { id: string };
            await withdrawFromCompetition(req.user!.id, id);
            return reply.send({ ok: true });
        } catch (err) {
            return v1HandleError(reply, err);
        }
    });

    // GET /competitions/:id/equity-curve
    app.get("/competitions/:id/equity-curve", {
        schema: {
            tags: ["Competitions"],
            summary: "Get your equity curve for a competition",
            security: [{ bearerAuth: [] }],
            params: {
                type: "object",
                required: ["id"],
                properties: { id: { type: "string", format: "uuid" } },
            },
            querystring: {
                type: "object",
                properties: {
                    limit: { type: "integer", minimum: 1, maximum: 1000, default: 500 },
                },
            },
            response: {
                200: {
                    type: "object",
                    properties: {
                        ok: { type: "boolean", const: true },
                        snapshots: {
                            type: "array",
                            items: {
                                type: "object",
                                properties: {
                                    ts: { type: "number" },
                                    equity_quote: { type: "string" },
                                    cash_quote: { type: "string" },
                                    holdings_quote: { type: "string" },
                                },
                            },
                        },
                    },
                },
            },
        },
        preHandler: requireUser,
    }, async (req, reply) => {
        try {
            const { id: competitionId } = req.params as { id: string };
            const { limit } = req.query as { limit?: number };
            const userId = req.user!.id;

            const { rows } = await pool.query(
                `SELECT ts, equity_quote, cash_quote, holdings_quote,
                        unrealized_pnl_quote, realized_pnl_quote, fees_paid_quote
                 FROM equity_snapshots
                 WHERE user_id = $1 AND competition_id = $2
                 ORDER BY ts ASC
                 LIMIT $3`,
                [userId, competitionId, limit ?? 500],
            );

            return reply.send({ ok: true, snapshots: rows });
        } catch (err) {
            return v1HandleError(reply, err);
        }
    });

    // GET /competitions/:id/comparison
    app.get("/competitions/:id/comparison", {
        schema: {
            tags: ["Competitions"],
            summary: "Get equity curves for top participants (comparison chart)",
            security: [{ bearerAuth: [] }],
            params: {
                type: "object",
                required: ["id"],
                properties: { id: { type: "string", format: "uuid" } },
            },
            querystring: {
                type: "object",
                properties: {
                    topN: { type: "integer", minimum: 2, maximum: 10, default: 5 },
                    limit: { type: "integer", minimum: 10, maximum: 500, default: 200 },
                },
            },
        },
        preHandler: requireUser,
    }, async (req, reply) => {
        try {
            const { id: competitionId } = req.params as { id: string };
            const query = req.query as { topN?: number; limit?: number };
            const topN = query.topN ?? 5;
            const limit = query.limit ?? 200;
            const userId = req.user!.id;

            // Get top N from leaderboard
            const { rows: leaders } = await pool.query<{
                user_id: string;
                rank: number;
                display_name: string;
            }>(
                `SELECT lb.user_id, lb.rank,
                        COALESCE(u.display_name, SPLIT_PART(u.email, '@', 1)) AS display_name
                 FROM competition_leaderboard lb
                 JOIN users u ON u.id = lb.user_id
                 WHERE lb.competition_id = $1
                 ORDER BY lb.rank ASC
                 LIMIT $2`,
                [competitionId, topN],
            );

            if (leaders.length === 0) {
                return reply.send({ ok: true, participants: [] });
            }

            // Ensure the current user is included (even if not in top N)
            const leaderUserIds = leaders.map((l) => l.user_id);
            const includesUser = leaderUserIds.includes(userId);

            const allUserIds = includesUser
                ? leaderUserIds
                : [...leaderUserIds, userId];

            // Fetch equity curves for all selected users
            const { rows: snapshots } = await pool.query<{
                user_id: string;
                ts: number;
                equity_quote: string;
            }>(
                `SELECT user_id, ts, equity_quote
                 FROM equity_snapshots
                 WHERE competition_id = $1 AND user_id = ANY($2)
                 ORDER BY ts ASC`,
                [competitionId, allUserIds],
            );

            // Group by user
            const byUser = new Map<string, Array<{ ts: number; equity: string }>>();
            for (const s of snapshots) {
                const arr = byUser.get(s.user_id) ?? [];
                arr.push({ ts: s.ts, equity: s.equity_quote });
                byUser.set(s.user_id, arr);
            }

            // Build response — anonymize other users (show rank, not name)
            const participants = allUserIds.map((uid) => {
                const leader = leaders.find((l) => l.user_id === uid);
                const isCurrentUser = uid === userId;
                return {
                    userId: isCurrentUser ? uid : undefined,
                    label: isCurrentUser
                        ? "You"
                        : `#${leader?.rank ?? "?"}`,
                    rank: leader?.rank ?? null,
                    displayName: isCurrentUser ? (leader?.display_name ?? "You") : undefined,
                    snapshots: (byUser.get(uid) ?? []).slice(-limit),
                };
            });

            return reply.send({ ok: true, participants });
        } catch (err) {
            return v1HandleError(reply, err);
        }
    });

    // ═══ Admin routes ═══

    // POST /admin/competitions — create
    app.post("/admin/competitions", {
        schema: {
            tags: ["Admin"],
            summary: "Create competition",
            description: "Create a new competition. Requires ADMIN role.",
            security: [{ bearerAuth: [] }],
            response: {
                201: {
                    type: "object",
                    properties: {
                        data: { type: "object", additionalProperties: true },
                    },
                },
            },
        },
        preHandler: [requireUser, requireRole("ADMIN")],
    }, async (req, reply) => {
        try {
            const body = createCompetitionBody.parse(req.body);
            const comp = await createCompetition({
                name: body.name,
                description: body.description,
                startAt: body.startAt,
                endAt: body.endAt,
                startingBalanceUsd: body.startingBalanceUsd,
                maxParticipants: body.maxParticipants,
                pairsAllowed: body.pairsAllowed,
                createdBy: req.user!.id,
            });
            return reply.code(201).send({ data: comp });
        } catch (err) {
            return v1HandleError(reply, err);
        }
    });

    // PATCH /admin/competitions/:id/cancel
    app.patch("/admin/competitions/:id/cancel", {
        schema: {
            tags: ["Admin"],
            summary: "Cancel competition",
            description: "Cancel a competition. Must be UPCOMING or ACTIVE. Requires ADMIN role.",
            security: [{ bearerAuth: [] }],
            params: {
                type: "object",
                properties: { id: { type: "string", format: "uuid" } },
                required: ["id"],
            },
            response: {
                200: {
                    type: "object",
                    properties: { ok: { type: "boolean" } },
                },
            },
        },
        preHandler: [requireUser, requireRole("ADMIN")],
    }, async (req, reply) => {
        try {
            const { id } = req.params as { id: string };
            const client = await pool.connect();
            try {
                await client.query("BEGIN");
                const comp = await lockCompetitionForUpdate(client, id);
                if (!comp) throw new AppError("competition_not_found");
                if (comp.status !== "UPCOMING" && comp.status !== "ACTIVE") {
                    throw new AppError("competition_not_joinable", { status: comp.status });
                }
                await updateCompetitionStatus(client, id, "CANCELLED");
                await client.query("COMMIT");
            } catch (err) {
                await client.query("ROLLBACK").catch(() => {});
                throw err;
            } finally {
                client.release();
            }
            return reply.send({ ok: true });
        } catch (err) {
            return v1HandleError(reply, err);
        }
    });

    // PATCH /admin/competitions/:id/participants/:userId/disqualify
    app.patch("/admin/competitions/:id/participants/:userId/disqualify", {
        schema: {
            tags: ["Admin"],
            summary: "Disqualify participant",
            description: "Disqualify a participant from a competition. Cancels their open orders. Requires ADMIN role.",
            security: [{ bearerAuth: [] }],
            params: {
                type: "object",
                properties: {
                    id: { type: "string", format: "uuid" },
                    userId: { type: "string", format: "uuid" },
                },
                required: ["id", "userId"],
            },
            response: {
                200: {
                    type: "object",
                    properties: { ok: { type: "boolean" } },
                },
            },
        },
        preHandler: [requireUser, requireRole("ADMIN")],
    }, async (req, reply) => {
        try {
            const { id, userId } = req.params as { id: string; userId: string };

            const participant = await findParticipant(id, userId);
            if (!participant || participant.status !== "ACTIVE") {
                throw new AppError("not_participating");
            }

            const client = await pool.connect();
            try {
                await client.query("BEGIN");

                await updateParticipantStatus(client, id, userId, "DISQUALIFIED");

                // Cancel open orders
                await client.query(
                    `UPDATE orders SET status = 'CANCELED'
                     WHERE user_id = $1 AND competition_id = $2
                       AND status IN ('OPEN', 'PARTIALLY_FILLED')`,
                    [userId, id],
                );

                await client.query("COMMIT");
            } catch (err) {
                await client.query("ROLLBACK").catch(() => {});
                throw err;
            } finally {
                client.release();
            }

            return reply.send({ ok: true });
        } catch (err) {
            return v1HandleError(reply, err);
        }
    });
};

export default v1Competitions;
