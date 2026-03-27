import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requireUser } from "../../auth/requireUser.js";
import { v1HandleError } from "../../http/v1Error.js";
import {
    createMatch,
    acceptMatch,
    forfeitMatch,
    cancelActiveMatch,
    getMatchById,
    getActiveMatchForUser,
    getMatchHistory,
} from "../../competitions/matchService.js";
import { pool } from "../../db/pool.js";

const challengeBody = z.object({
    opponentId: z.string().uuid(),
    durationHours: z.number().int().refine((v) => [24, 168, 336, 504, 672].includes(v), {
        message: "Duration must be 24, 168, 336, 504, or 672 hours",
    }),
    allowedPairIds: z.array(z.string().uuid()).min(1).max(10),
});

const v1Matches: FastifyPluginAsync = async (app) => {

    // POST /v1/matches/challenge — send a match challenge
    app.post("/matches/challenge", {
        schema: {
            tags: ["Matches"],
            summary: "Challenge another user to a 1v1 match",
            security: [{ bearerAuth: [] }],
        },
        preHandler: requireUser,
    }, async (req, reply) => {
        try {
            const body = challengeBody.parse(req.body);
            const userId = req.user!.id;
            const match = await createMatch(
                userId,
                body.opponentId,
                body.durationHours,
                body.allowedPairIds,
            );
            return reply.code(201).send({ ok: true, match });
        } catch (err) {
            return v1HandleError(reply, err);
        }
    });

    // POST /v1/matches/:id/accept — accept a pending challenge
    app.post("/matches/:id/accept", {
        schema: {
            tags: ["Matches"],
            summary: "Accept a match challenge",
            security: [{ bearerAuth: [] }],
        },
        preHandler: requireUser,
    }, async (req, reply) => {
        try {
            const { id } = req.params as { id: string };
            const userId = req.user!.id;
            const match = await acceptMatch(id, userId);
            return reply.send({ ok: true, match });
        } catch (err) {
            return v1HandleError(reply, err);
        }
    });

    // POST /v1/matches/:id/forfeit — forfeit an active match
    app.post("/matches/:id/forfeit", {
        schema: {
            tags: ["Matches"],
            summary: "Forfeit an active match",
            security: [{ bearerAuth: [] }],
        },
        preHandler: requireUser,
    }, async (req, reply) => {
        try {
            const { id } = req.params as { id: string };
            const userId = req.user!.id;
            const match = await forfeitMatch(id, userId);
            return reply.send({ ok: true, match });
        } catch (err) {
            return v1HandleError(reply, err);
        }
    });

    // GET /v1/matches/active — get current user's active match
    app.get("/matches/active", {
        schema: {
            tags: ["Matches"],
            summary: "Get current active or pending match",
            security: [{ bearerAuth: [] }],
        },
        preHandler: requireUser,
    }, async (req, reply) => {
        try {
            const userId = req.user!.id;
            const match = await getActiveMatchForUser(userId);
            return reply.send({ ok: true, match });
        } catch (err) {
            return v1HandleError(reply, err);
        }
    });

    // GET /v1/matches/:id — get match details
    app.get("/matches/:id", {
        schema: {
            tags: ["Matches"],
            summary: "Get match details by ID",
            security: [{ bearerAuth: [] }],
        },
        preHandler: requireUser,
    }, async (req, reply) => {
        try {
            const { id } = req.params as { id: string };
            const match = await getMatchById(id);
            if (!match) throw new Error("match_not_found");
            return reply.send({ ok: true, match });
        } catch (err) {
            return v1HandleError(reply, err);
        }
    });

    // GET /v1/matches/:id/result — get detailed ELO result for a completed match
    app.get("/matches/:id/result", {
        schema: {
            tags: ["Matches"],
            summary: "Get ELO result details for a completed match",
            security: [{ bearerAuth: [] }],
        },
        preHandler: requireUser,
    }, async (req, reply) => {
        try {
            const { id } = req.params as { id: string };
            const { rows } = await pool.query(
                `SELECT * FROM match_elo_results WHERE match_id = $1`,
                [id],
            );
            if (rows.length === 0) {
                return reply.code(404).send({ ok: false, error: "no_elo_result" });
            }
            return reply.send({ ok: true, result: rows[0] });
        } catch (err) {
            return v1HandleError(reply, err);
        }
    });

    // POST /v1/matches/active/cancel — cancel a stuck active/pending match
    app.post("/matches/active/cancel", {
        schema: {
            tags: ["Matches"],
            summary: "Cancel your active or pending match (no trades only)",
            security: [{ bearerAuth: [] }],
        },
        preHandler: requireUser,
    }, async (req, reply) => {
        try {
            const userId = req.user!.id;
            const match = await cancelActiveMatch(userId);
            return reply.send({ ok: true, match });
        } catch (err) {
            return v1HandleError(reply, err);
        }
    });

    // GET /v1/matches/history — get match history for current user
    app.get("/matches/history", {
        schema: {
            tags: ["Matches"],
            summary: "Get match history for current user",
            security: [{ bearerAuth: [] }],
        },
        preHandler: requireUser,
    }, async (req, reply) => {
        try {
            const userId = req.user!.id;
            const query = req.query as { limit?: string; offset?: string };
            const limit = query.limit ? parseInt(query.limit, 10) : 20;
            const offset = query.offset ? parseInt(query.offset, 10) : 0;
            const result = await getMatchHistory(userId, limit, offset);
            return reply.send({ ok: true, ...result });
        } catch (err) {
            return v1HandleError(reply, err);
        }
    });
};

export default v1Matches;
