import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import { requireUser } from "../../auth/requireUser";
import { v1HandleError } from "../../http/v1Error";
import {
    startRun,
    pauseRun,
    resumeRun,
    stopRun,
    getRun,
    listRuns,
    listSignals,
} from "../../bot/strategyBotService";

/* ── Zod schemas ──────────────────────────────── */

const startRunBody = z.object({
    pairId: z.string().uuid(),
    mode: z.enum(["REPLAY", "LIVE"]),
    params: z
        .object({
            adxThreshold: z.number().positive().optional(),
            atrMultiplierSL: z.number().positive().optional(),
            atrMultiplierTrailing: z.number().positive().optional(),
            rMultipleTPTrend: z.number().positive().optional(),
            rMultipleTPRange: z.number().positive().optional(),
            partialExitThreshold: z.number().positive().optional(),
            eqTolerance: z.number().positive().optional(),
            maxHoldingHours: z.number().positive().optional(),
        })
        .optional(),
});

const runIdParams = z.object({ id: z.string().uuid() });

const paginationQuery = z.object({
    cursor: z.string().optional(),
    limit: z.string().optional(),
});

/* ── Routes ───────────────────────────────────── */

const v1Bot: FastifyPluginAsync = async (app) => {
    // POST /v1/bot/runs — start a new bot run
    app.post("/bot/runs", {
        schema: {
            tags: ["Bot"],
            summary: "Start a new bot run",
            description: "Starts a strategy bot run in REPLAY or LIVE mode for the specified pair.",
            security: [{ bearerAuth: [] }],
            body: {
                type: "object",
                required: ["pairId", "mode"],
                properties: {
                    pairId: { type: "string", format: "uuid" },
                    mode: { type: "string", enum: ["REPLAY", "LIVE"] },
                    params: { type: "object", description: "Optional strategy parameters (adxThreshold, atrMultiplierSL, etc.)" },
                },
            },
            response: {
                201: { type: "object", properties: { ok: { type: "boolean" }, run: { type: "object", additionalProperties: true } } },
                400: { type: "object", additionalProperties: true },
            },
        },
        preHandler: requireUser,
    }, async (req, reply) => {
        try {
            const actor = req.user!;
            const parsed = startRunBody.safeParse(req.body);
            if (!parsed.success) {
                const { AppError } = await import("../../errors/AppError");
                throw new AppError("invalid_input", parsed.error.flatten());
            }
            const b = parsed.data;

            const run = await startRun(actor.id, b.pairId, b.mode, b.params);
            return reply.code(201).send({ ok: true, run });
        } catch (err) {
            return v1HandleError(reply, err);
        }
    });

    // POST /v1/bot/runs/:id/pause
    app.post("/bot/runs/:id/pause", {
        schema: {
            tags: ["Bot"],
            summary: "Pause a bot run",
            description: "Pauses a running bot. Can be resumed later.",
            security: [{ bearerAuth: [] }],
            params: { type: "object", required: ["id"], properties: { id: { type: "string", format: "uuid" } } },
            response: {
                200: { type: "object", properties: { ok: { type: "boolean" }, run: { type: "object", additionalProperties: true } } },
                400: { type: "object", additionalProperties: true },
            },
        },
        preHandler: requireUser,
    }, async (req, reply) => {
        try {
            const actor = req.user!;
            const p = runIdParams.safeParse(req.params);
            if (!p.success) {
                const { AppError } = await import("../../errors/AppError");
                throw new AppError("invalid_input", p.error.flatten());
            }

            const run = await pauseRun(actor.id, p.data.id);
            return reply.send({ ok: true, run });
        } catch (err) {
            return v1HandleError(reply, err);
        }
    });

    // POST /v1/bot/runs/:id/resume
    app.post("/bot/runs/:id/resume", {
        schema: {
            tags: ["Bot"],
            summary: "Resume a paused bot run",
            description: "Resumes a previously paused bot run.",
            security: [{ bearerAuth: [] }],
            params: { type: "object", required: ["id"], properties: { id: { type: "string", format: "uuid" } } },
            response: {
                200: { type: "object", properties: { ok: { type: "boolean" }, run: { type: "object", additionalProperties: true } } },
                400: { type: "object", additionalProperties: true },
            },
        },
        preHandler: requireUser,
    }, async (req, reply) => {
        try {
            const actor = req.user!;
            const p = runIdParams.safeParse(req.params);
            if (!p.success) {
                const { AppError } = await import("../../errors/AppError");
                throw new AppError("invalid_input", p.error.flatten());
            }

            const run = await resumeRun(actor.id, p.data.id);
            return reply.send({ ok: true, run });
        } catch (err) {
            return v1HandleError(reply, err);
        }
    });

    // POST /v1/bot/runs/:id/stop
    app.post("/bot/runs/:id/stop", {
        schema: {
            tags: ["Bot"],
            summary: "Stop a bot run",
            description: "Permanently stops a bot run. Cannot be resumed after stopping.",
            security: [{ bearerAuth: [] }],
            params: { type: "object", required: ["id"], properties: { id: { type: "string", format: "uuid" } } },
            response: {
                200: { type: "object", properties: { ok: { type: "boolean" }, run: { type: "object", additionalProperties: true } } },
                400: { type: "object", additionalProperties: true },
            },
        },
        preHandler: requireUser,
    }, async (req, reply) => {
        try {
            const actor = req.user!;
            const p = runIdParams.safeParse(req.params);
            if (!p.success) {
                const { AppError } = await import("../../errors/AppError");
                throw new AppError("invalid_input", p.error.flatten());
            }

            const run = await stopRun(actor.id, p.data.id);
            return reply.send({ ok: true, run });
        } catch (err) {
            return v1HandleError(reply, err);
        }
    });

    // GET /v1/bot/runs — list user's bot runs (paginated)
    app.get("/bot/runs", {
        schema: {
            tags: ["Bot"],
            summary: "List bot runs (paginated)",
            description: "Returns paginated list of the user's bot runs.",
            security: [{ bearerAuth: [] }],
            querystring: {
                type: "object",
                properties: {
                    cursor: { type: "string" },
                    limit: { type: "string" },
                },
            },
            response: {
                200: { type: "object", properties: { ok: { type: "boolean" }, data: { type: "array", items: { type: "object", additionalProperties: true } }, nextCursor: { type: "string", nullable: true } } },
            },
        },
        preHandler: requireUser,
    }, async (req, reply) => {
        try {
            const actor = req.user!;
            const q = paginationQuery.safeParse(req.query);
            const query = q.success ? q.data : {};

            const page = await listRuns(actor.id, query.cursor, query.limit);
            return reply.send({ ok: true, ...page });
        } catch (err) {
            return v1HandleError(reply, err);
        }
    });

    // GET /v1/bot/runs/:id — get a single run
    app.get("/bot/runs/:id", {
        schema: {
            tags: ["Bot"],
            summary: "Get bot run details",
            description: "Returns details of a specific bot run including status, parameters, and metrics.",
            security: [{ bearerAuth: [] }],
            params: { type: "object", required: ["id"], properties: { id: { type: "string", format: "uuid" } } },
            response: {
                200: { type: "object", properties: { ok: { type: "boolean" }, run: { type: "object", additionalProperties: true } } },
                404: { type: "object", additionalProperties: true },
            },
        },
        preHandler: requireUser,
    }, async (req, reply) => {
        try {
            const actor = req.user!;
            const p = runIdParams.safeParse(req.params);
            if (!p.success) {
                const { AppError } = await import("../../errors/AppError");
                throw new AppError("invalid_input", p.error.flatten());
            }

            const run = await getRun(actor.id, p.data.id);
            return reply.send({ ok: true, run });
        } catch (err) {
            return v1HandleError(reply, err);
        }
    });

    // GET /v1/bot/runs/:id/signals — list signals for a run (paginated)
    app.get("/bot/runs/:id/signals", {
        schema: {
            tags: ["Bot"],
            summary: "List signals for a bot run (paginated)",
            description: "Returns paginated trading signals generated by a specific bot run.",
            security: [{ bearerAuth: [] }],
            params: { type: "object", required: ["id"], properties: { id: { type: "string", format: "uuid" } } },
            querystring: {
                type: "object",
                properties: {
                    cursor: { type: "string" },
                    limit: { type: "string" },
                },
            },
            response: {
                200: { type: "object", properties: { ok: { type: "boolean" }, data: { type: "array", items: { type: "object", additionalProperties: true } }, nextCursor: { type: "string", nullable: true } } },
            },
        },
        preHandler: requireUser,
    }, async (req, reply) => {
        try {
            const actor = req.user!;
            const p = runIdParams.safeParse(req.params);
            if (!p.success) {
                const { AppError } = await import("../../errors/AppError");
                throw new AppError("invalid_input", p.error.flatten());
            }

            const q = paginationQuery.safeParse(req.query);
            const query = q.success ? q.data : {};

            const page = await listSignals(actor.id, p.data.id, query.cursor, query.limit);
            return reply.send({ ok: true, ...page });
        } catch (err) {
            return v1HandleError(reply, err);
        }
    });
};

export default v1Bot;
