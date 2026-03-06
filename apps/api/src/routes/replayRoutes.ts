import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import { requireUser } from "../auth/requireUser";
import { auditLog } from "../audit/log";
import { handleError } from "../http/handleError";
import { findPairById } from "../trading/pairRepo";
import {
    createOrStartSession,
    getSession,
    setPaused,
    seek,
    stopSession,
} from "../replay/replayRepo";
import { AppError } from "../errors/AppError";

// ── Zod schemas ──
const startBody = z.object({
    pairId: z.string().uuid(),
    startTs: z.string().datetime(),
    timeframe: z.enum(["1m", "5m", "15m", "1h", "4h", "1d"]).default("1m"),
    speed: z.number().min(0.1).max(100).default(1),
});

const seekBody = z.object({
    pairId: z.string().uuid(),
    ts: z.string().datetime(),
});

const pairIdBody = z.object({
    pairId: z.string().uuid(),
});

const stateQuery = z.object ({
    pairId: z.string().uuid(),
});

// ── Plugin (registered with prefix "/replay") ──
const replayRoutes: FastifyPluginAsync = async (app) => {

    // POST /replay/start
    app.post("/start", { schema: { tags: ["Replay"], summary: "Start replay session", description: "Creates or restarts a historical replay session for a trading pair.", security: [{ bearerAuth: [] }], body: { type: "object", required: ["pairId", "startTs"], properties: { pairId: { type: "string", format: "uuid" }, startTs: { type: "string", format: "date-time" }, timeframe: { type: "string", enum: ["1m", "5m", "15m", "1h", "4h", "1d"], default: "1m" }, speed: { type: "number", minimum: 0.1, maximum: 100, default: 1 } } }, response: { 201: { type: "object", properties: { ok: { type: "boolean" }, session: { type: "object", additionalProperties: true } } }, 400: { type: "object", properties: { ok: { type: "boolean" }, error: { type: "string" } } }, 404: { type: "object", properties: { ok: { type: "boolean" }, error: { type: "string" } } } } }, preHandler: requireUser }, async (req, reply) => {
        const parsed = startBody.safeParse(req.body);
        if (!parsed.success) {
            return reply.code(400).send({ ok: false, error: "invalid_input", details: parsed.error.flatten() });
        }

        const pair = await findPairById(parsed.data.pairId);
        if (!pair) {
            return reply.code(404).send({ ok: false, error: "pair_not_found" });
        }

        const actor = req.user!;
        const session = await createOrStartSession(
            actor.id,
            parsed.data.pairId,
            parsed.data.startTs,
            parsed.data.timeframe,
            parsed.data.speed
        );

        await auditLog({
            actorUserId: actor.id,
            action: "replay.start",
            targetType: "replay_session",
            targetId: parsed.data.pairId,
            requestId: req.id,
            ip: req.ip,
            userAgent: req.headers["user-agent"] ?? null,
            metadata: { pairid: parsed.data.pairId, startTs: parsed.data.startTs, timeframe: parsed.data.timeframe, speed: parsed.data.speed },
        });

        return reply.code(201).send({ ok: true, session });
    });

    // POST /replay/pause
    app.post("/pause", { schema: { tags: ["Replay"], summary: "Pause replay", description: "Pauses a running replay session.", security: [{ bearerAuth: [] }], body: { type: "object", required: ["pairId"], properties: { pairId: { type: "string", format: "uuid" } } }, response: { 200: { type: "object", properties: { ok: { type: "boolean" }, session: { type: "object", additionalProperties: true } } }, 400: { type: "object", properties: { ok: { type: "boolean" }, error: { type: "string" } } } } }, preHandler: requireUser }, async (req, reply) => {
        const parsed = pairIdBody.safeParse(req.body);
        if (!parsed.success) {
            return reply.code(400).send({ ok: false, error: "invalid_input", details: parsed.error.flatten() });
        }

        const actor = req.user!;
        const session = await setPaused(actor.id, parsed.data.pairId, true);
        if (!session) {
            return handleError(reply, new AppError("replay_not_found"));
        }

        await auditLog({
            actorUserId: actor.id,
            action: "replay.pause",
            targetType: "replay_session",
            targetId: parsed.data.pairId,
            requestId: req.id,
            ip: req.ip,
            userAgent: req.headers["user-agent"] ?? null,
            metadata: { pairId: parsed.data.pairId },
        });

        return reply.send({ ok: true, session });
    });

    // POST /replay/resume
    app.post("/resume", { schema: { tags: ["Replay"], summary: "Resume replay", description: "Resumes a paused replay session.", security: [{ bearerAuth: [] }], body: { type: "object", required: ["pairId"], properties: { pairId: { type: "string", format: "uuid" } } }, response: { 200: { type: "object", properties: { ok: { type: "boolean" }, session: { type: "object", additionalProperties: true } } }, 400: { type: "object", properties: { ok: { type: "boolean" }, error: { type: "string" } } } } }, preHandler: requireUser }, async (req, reply) => {
        const parsed = pairIdBody.safeParse(req.body);
        if (!parsed.success) {
            return reply.code(400).send({ ok: false, error: "invalid_input", details: parsed.error.flatten() });
        }

        const actor = req.user!;
        const session = await setPaused(actor.id, parsed.data.pairId, false);
        if (!session) {
            return handleError(reply, new AppError("replay_not_found"));
        }

        await auditLog({
            actorUserId: actor.id,
            action: "replay.resume",
            targetType: "replay_session",
            targetId: parsed.data.pairId,
            requestId: req.id,
            ip: req.ip,userAgent: req.headers["user-agent"] ?? null,
            metadata: { pairId: parsed.data.pairId },
        });

        return reply.send({ ok: true, session });
    });

    // POST /replay/seek
    app.post("/seek", { schema: { tags: ["Replay"], summary: "Seek replay", description: "Jumps to a specific timestamp in the replay session.", security: [{ bearerAuth: [] }], body: { type: "object", required: ["pairId", "ts"], properties: { pairId: { type: "string", format: "uuid" }, ts: { type: "string", format: "date-time" } } }, response: { 200: { type: "object", properties: { ok: { type: "boolean" }, session: { type: "object", additionalProperties: true } } }, 400: { type: "object", properties: { ok: { type: "boolean" }, error: { type: "string" } } } } }, preHandler: requireUser }, async (req, reply) => {
        const parsed = seekBody.safeParse(req.body);
        if (!parsed.success) {
            return reply.code(400).send({ ok: false, error: "invalid_input", details: parsed.error.flatten() });
        }

        const actor = req.user!;
        const session = await seek(actor.id, parsed.data.pairId, parsed.data.ts);
        if (!session) {
            return handleError(reply, new AppError("replay_not_found"));
        }

        await auditLog({
            actorUserId: actor.id,
            action: "replay.seek",
            targetType: "replay_session",
            targetId: parsed.data.pairId,
            requestId: req.id,
            ip: req.ip,
            userAgent: req.headers["user-agent"] ?? null,
            metadata: { pairId: parsed.data.pairId, ts: parsed.data.ts },
        });

        return reply.send({ ok: true, session });
    });

    // POST /replay/stop
    app.post("/stop", { schema: { tags: ["Replay"], summary: "Stop replay", description: "Stops and deletes a replay session.", security: [{ bearerAuth: [] }], body: { type: "object", required: ["pairId"], properties: { pairId: { type: "string", format: "uuid" } } }, response: { 200: { type: "object", properties: { ok: { type: "boolean" }, stopped: { type: "boolean" } } }, 400: { type: "object", properties: { ok: { type: "boolean" }, error: { type: "string" } } } } }, preHandler: requireUser }, async (req, reply) => {
        const parsed = pairIdBody.safeParse(req.body);
        if (!parsed.success) {
            return reply.code(400).send({ ok: false, error: "invalid_input", details: parsed.error.flatten() });
        }

        const actor = req.user!;
        const deleted = await stopSession(actor.id, parsed.data.pairId);
        if (!deleted) {
            return handleError(reply, new AppError("replay_not_found"));
        }

        await auditLog({
            actorUserId: actor.id,
            action: "replay.stop",
            targetType: "replay_session",
            targetId: parsed.data.pairId,
            requestId: req.id,
            ip: req.ip,
            userAgent: req.headers["user-agent"] ?? null,
            metadata: { pairId: parsed.data.pairId },
        });

        return reply.send({ ok: true, stopped: true });
    });

    // GET /replay/state?pairId=
    app.get("/state", { schema: { tags: ["Replay"], summary: "Replay state", description: "Returns the current state of a replay session.", security: [{ bearerAuth: [] }], querystring: { type: "object", required: ["pairId"], properties: { pairId: { type: "string", format: "uuid" } } }, response: { 200: { type: "object", properties: { ok: { type: "boolean" }, session: { type: "object", additionalProperties: true } } }, 400: { type: "object", properties: { ok: { type: "boolean" }, error: { type: "string" } } }, 404: { type: "object", properties: { ok: { type: "boolean" }, error: { type: "string" } } } } }, preHandler: requireUser }, async (req, reply) => {
        const parsed = stateQuery.safeParse(req.query);
        if (!parsed.success) {
            return reply.code(400).send({ ok: false, error: "invalid_input", details: parsed.error.flatten() });
        }

        const actor = req.user!;
        const session = await getSession(actor.id, parsed.data.pairId);
        if (!session) {
            return reply.code(404).send({ ok: false, error: "replay_not_found" });
        }

        return reply.send({ ok: true, session });
    });
};

export default replayRoutes;