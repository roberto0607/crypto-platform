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
    listActiveMatches,
    canViewMatch,
} from "../../competitions/matchService.js";
import { getMatchReplay, ReplayError } from "../../competitions/replay/replayService.js";
import { getMatchBreakdown, BreakdownError } from "../../competitions/breakdown/breakdownService.js";
import { getSpectatorCount } from "../../competitions/matchSpectatorStore.js";
import { joinMatchSpectatorRoom, leaveMatchSpectatorRoom } from "../../competitions/matchSpectatorSession.js";
import { getStreamHandler, setStreamSpectatingMatch, getStreamSpectatingMatch } from "./v1Events.js";
import { pool } from "../../db/pool.js";
import { parseIntParam } from "../../http/pagination.js";

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

    // GET /v1/matches/active-list — all currently-active matches, for spectating.
    // Public to any authenticated user, unscoped to the requester — the
    // browse list a spectator picks a match from. Not present on /matches/:id
    // since a fully public feature has no ownership filter to apply.
    app.get("/matches/active-list", {
        schema: {
            tags: ["Matches"],
            summary: "List all currently-active matches (for spectating)",
            security: [{ bearerAuth: [] }],
            querystring: {
                type: "object",
                properties: {
                    limit: { type: "string", description: "Max matches to return (default 50, max 200)" },
                },
            },
        },
        preHandler: requireUser,
    }, async (req, reply) => {
        try {
            const query = req.query as { limit?: string };
            const limit = parseIntParam(query.limit, 50, 1, 200);
            const matches = await listActiveMatches(limit);
            const withCounts = await Promise.all(
                matches.map(async (match) => ({
                    ...match,
                    spectatorCount: await getSpectatorCount(match.id),
                })),
            );
            return reply.send({ ok: true, matches: withCounts });
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
            const userId = req.user!.id;
            const viewerRole = canViewMatch(match, userId);
            if (viewerRole === "none") {
                return reply.code(403).send({ ok: false, error: "forbidden" });
            }
            return reply.send({ ok: true, match, viewerRole });
        } catch (err) {
            return v1HandleError(reply, err);
        }
    });

    // POST /v1/matches/:id/spectate — join a match's live spectator room.
    // Fully public to any non-participant while the match is ACTIVE, per the
    // locked spectating design — no invite/friendship/tier gate.
    app.post("/matches/:id/spectate", {
        schema: {
            tags: ["Matches"],
            summary: "Start spectating an active match",
            security: [{ bearerAuth: [] }],
            body: {
                type: "object",
                required: ["streamId"],
                properties: { streamId: { type: "string", format: "uuid" } },
            },
        },
        preHandler: requireUser,
    }, async (req, reply) => {
        try {
            const { id: matchId } = req.params as { id: string };
            const { streamId } = req.body as { streamId: string };
            const userId = req.user!.id;

            const match = await getMatchById(matchId);
            if (!match) {
                return reply.code(404).send({ ok: false, error: "match_not_found" });
            }
            if (match.challenger_id === userId || match.opponent_id === userId) {
                // Participants already receive every match-scoped event via
                // their own userId — spectating your own match would be a
                // redundant registration, not a real use case.
                return reply.code(403).send({ ok: false, error: "forbidden" });
            }
            if (match.status !== "ACTIVE") {
                return reply.code(422).send({ ok: false, error: "match_not_active" });
            }

            const handler = getStreamHandler(streamId, userId);
            if (!handler) {
                return reply.code(404).send({ ok: false, error: "stream_not_found" });
            }

            // A stream can only spectate one match at a time — leave whatever
            // it was previously watching first so it never lingers in two
            // rooms (e.g. a client that switched matches without calling
            // /unspectate first).
            const previousMatchId = getStreamSpectatingMatch(streamId);
            if (previousMatchId && previousMatchId !== matchId) {
                await leaveMatchSpectatorRoom(previousMatchId, userId, handler);
            }

            const spectatorCount = await joinMatchSpectatorRoom(matchId, userId, handler);
            setStreamSpectatingMatch(streamId, matchId);

            return reply.send({ ok: true, spectatorCount });
        } catch (err) {
            return v1HandleError(reply, err);
        }
    });

    // POST /v1/matches/:id/unspectate — leave a match's live spectator room.
    app.post("/matches/:id/unspectate", {
        schema: {
            tags: ["Matches"],
            summary: "Stop spectating a match",
            security: [{ bearerAuth: [] }],
            body: {
                type: "object",
                required: ["streamId"],
                properties: { streamId: { type: "string", format: "uuid" } },
            },
        },
        preHandler: requireUser,
    }, async (req, reply) => {
        try {
            const { id: matchId } = req.params as { id: string };
            const { streamId } = req.body as { streamId: string };
            const userId = req.user!.id;

            const handler = getStreamHandler(streamId, userId);
            if (!handler) {
                return reply.code(404).send({ ok: false, error: "stream_not_found" });
            }

            const watchingMatchId = getStreamSpectatingMatch(streamId);
            if (!watchingMatchId) {
                return reply.send({ ok: true, spectatorCount: await getSpectatorCount(matchId) });
            }

            const spectatorCount = await leaveMatchSpectatorRoom(watchingMatchId, userId, handler);
            setStreamSpectatingMatch(streamId, null);

            return reply.send({ ok: true, spectatorCount });
        } catch (err) {
            return v1HandleError(reply, err);
        }
    });

    // GET /v1/matches/:id/replay — per-candle P&L reconstruction for replay
    app.get("/matches/:id/replay", {
        schema: {
            tags: ["Matches"],
            summary: "Get candle-by-candle replay data (both players' reconstructed P&L curves)",
            security: [{ bearerAuth: [] }],
        },
        preHandler: requireUser,
    }, async (req, reply) => {
        try {
            const { id } = req.params as { id: string };
            const userId = req.user!.id;
            // Mirror GET /matches/:id: only the two participants may view.
            const match = await getMatchById(id);
            if (!match) {
                return reply.code(404).send({ ok: false, error: "match_not_found" });
            }
            if (match.challenger_id !== userId && match.opponent_id !== userId) {
                return reply.code(403).send({ ok: false, error: "forbidden" });
            }
            const replay = await getMatchReplay(id);
            return reply.send({ ok: true, ...replay });
        } catch (err) {
            if (err instanceof ReplayError) {
                const status = err.code === "match_not_found" ? 404 : 422;
                return reply.code(status).send({ ok: false, error: err.code });
            }
            return v1HandleError(reply, err);
        }
    });

    // GET /v1/matches/:id/breakdown — both players' orders for the match (post-match transparency)
    app.get("/matches/:id/breakdown", {
        schema: {
            tags: ["Matches"],
            summary: "Get both players' trade breakdown for a completed match",
            security: [{ bearerAuth: [] }],
        },
        preHandler: requireUser,
    }, async (req, reply) => {
        try {
            const { id } = req.params as { id: string };
            const userId = req.user!.id;
            // Mirror GET /matches/:id: only the two participants may view.
            const match = await getMatchById(id);
            if (!match) {
                return reply.code(404).send({ ok: false, error: "match_not_found" });
            }
            if (match.challenger_id !== userId && match.opponent_id !== userId) {
                return reply.code(403).send({ ok: false, error: "forbidden" });
            }
            const breakdown = await getMatchBreakdown(id);
            return reply.send({ ok: true, ...breakdown });
        } catch (err) {
            if (err instanceof BreakdownError) {
                const status = err.code === "match_not_found" ? 404 : 403;
                return reply.code(status).send({ ok: false, error: err.code });
            }
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
            const userId = req.user!.id;

            // Ownership check: only match participants may view the ELO result.
            const match = await getMatchById(id);
            if (!match) {
                return reply.code(404).send({ ok: false, error: "no_elo_result" });
            }
            if (match.challenger_id !== userId && match.opponent_id !== userId) {
                return reply.code(403).send({ ok: false, error: "forbidden" });
            }

            const { rows } = await pool.query(
                `SELECT match_id, winner_id, loser_id,
                        winner_old_elo, winner_new_elo, winner_delta,
                        loser_old_elo, loser_new_elo, loser_delta,
                        winner_tier_before, winner_tier_after,
                        loser_tier_before, loser_tier_after,
                        winner_win_streak, loser_loss_streak,
                        streak_multiplier, badges_earned, created_at
                 FROM match_elo_results WHERE match_id = $1`,
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
            const limit = parseIntParam(query.limit, 20, 1, 100);
            const offset = parseIntParam(query.offset, 0, 0, 1_000_000);
            const result = await getMatchHistory(userId, limit, offset);
            return reply.send({ ok: true, ...result });
        } catch (err) {
            return v1HandleError(reply, err);
        }
    });
};

export default v1Matches;
