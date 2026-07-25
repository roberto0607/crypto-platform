import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import { requireUser } from "../../auth/requireUser";
import { v1HandleError } from "../../http/v1Error";
import { decodeCursor, parseLimit, slicePage } from "../../http/pagination";
import {
    createAlert,
    listAlertsByUser,
    cancelAlertByUser,
    countActiveAlertsForUser,
} from "../../alerts/alertRepo";
import { AppError } from "../../errors/AppError";
import type { AlertRow } from "../../alerts/alertTypes";
import { publish } from "../../events/eventBus";
import { createEvent } from "../../events/eventTypes";

const MAX_ACTIVE_ALERTS_PER_USER = 50;

const decimalStr = z.string().regex(/^\d+(\.\d{1,8})?$/);

const createAlertBody = z
    .object({
        pairId: z.string().uuid(),
        conditionType: z.enum(["CROSSING", "CROSSING_UP", "CROSSING_DOWN"]),
        targetValue: decimalStr,
        frequency: z.enum(["ONCE", "EVERY_N_MINUTES"]),
        frequencyMinutes: z.number().int().positive().optional(),
        expiration: z.string().datetime().optional(),
        messageTemplate: z.string().max(500).optional(),
        channels: z.array(z.string()).optional(),
    })
    .refine(
        (d) => {
            if (d.frequency === "EVERY_N_MINUTES" && d.frequencyMinutes === undefined) return false;
            if (d.frequency === "ONCE" && d.frequencyMinutes !== undefined) return false;
            return true;
        },
        {
            message: "frequencyMinutes is required for EVERY_N_MINUTES and forbidden for ONCE",
        }
    );

const listAlertsQuery = z.object({
    pairId: z.string().uuid().optional(),
    status: z.string().optional(),
    limit: z.string().optional(),
    cursor: z.string().optional(),
});

const v1Alerts: FastifyPluginAsync = async (app) => {
    // POST /v1/alerts — create a price alert
    app.post("/alerts", {
        schema: {
            tags: ["Alerts"],
            summary: "Create a price alert",
            description: "Creates a price alert that emails the user when a pair's price crosses the target value. Capped at 50 active alerts per user.",
            security: [{ bearerAuth: [] }],
            body: {
                type: "object",
                required: ["pairId", "conditionType", "targetValue", "frequency"],
                properties: {
                    pairId: { type: "string", format: "uuid" },
                    conditionType: { type: "string", enum: ["CROSSING", "CROSSING_UP", "CROSSING_DOWN"] },
                    targetValue: { type: "string", pattern: "^\\d+(\\.\\d{1,8})?$" },
                    frequency: { type: "string", enum: ["ONCE", "EVERY_N_MINUTES"] },
                    frequencyMinutes: { type: "integer", minimum: 1, description: "Required for EVERY_N_MINUTES, forbidden for ONCE" },
                    expiration: { type: "string", format: "date-time" },
                    messageTemplate: { type: "string", maxLength: 500 },
                    channels: { type: "array", items: { type: "string" }, description: "Defaults to [\"email\"]" },
                },
            },
            response: {
                201: { type: "object", additionalProperties: true },
                400: { type: "object", additionalProperties: true },
            },
        },
        preHandler: requireUser,
    }, async (req, reply) => {
        try {
            const actor = req.user!;
            const parsed = createAlertBody.safeParse(req.body);
            if (!parsed.success) {
                throw new AppError("invalid_input", parsed.error.flatten());
            }
            const b = parsed.data;

            const activeCount = await countActiveAlertsForUser(actor.id);
            if (activeCount >= MAX_ACTIVE_ALERTS_PER_USER) {
                throw new AppError("alert_limit_exceeded");
            }

            const alert = await createAlert({
                userId: actor.id,
                pairId: b.pairId,
                conditionType: b.conditionType,
                targetValue: b.targetValue,
                frequency: b.frequency,
                frequencyMinutes: b.frequencyMinutes,
                expiration: b.expiration,
                messageTemplate: b.messageTemplate,
                channels: b.channels,
            });

            publishAlertUpdated(alert.id, alert.pair_id, "created");

            return reply.code(201).send(alert);
        } catch (err) {
            return v1HandleError(reply, err);
        }
    });

    // GET /v1/alerts — list user's alerts (paginated)
    app.get("/alerts", {
        schema: {
            tags: ["Alerts"],
            summary: "List price alerts (paginated)",
            description: "Returns paginated price alerts for the authenticated user. Filter by pair or status.",
            security: [{ bearerAuth: [] }],
            querystring: {
                type: "object",
                properties: {
                    pairId: { type: "string", format: "uuid" },
                    status: { type: "string", description: "Filter by alert status (ACTIVE, FIRED, EXPIRED, CANCELLED)" },
                    limit: { type: "string" },
                    cursor: { type: "string" },
                },
            },
            response: {
                200: {
                    type: "object",
                    properties: {
                        data: { type: "array", items: { type: "object", additionalProperties: true } },
                        nextCursor: { type: "string", nullable: true },
                    },
                },
            },
        },
        preHandler: requireUser,
    }, async (req, reply) => {
        try {
            const actor = req.user!;
            const queryParsed = listAlertsQuery.safeParse(req.query);
            const q = queryParsed.success ? queryParsed.data : {};

            const limit = parseLimit(q.limit);
            const cursor = decodeCursor<{ ca: string; id: string }>(q.cursor);

            const rows = await listAlertsByUser(
                actor.id,
                { pairId: q.pairId, status: q.status },
                limit,
                cursor,
            );

            const page = slicePage(rows, limit, (row: AlertRow) => ({
                ca: row.created_at,
                id: row.id,
            }));

            return reply.send(page);
        } catch (err) {
            return v1HandleError(reply, err);
        }
    });

    // DELETE /v1/alerts/:id — cancel an ACTIVE alert (idempotent)
    app.delete(
        "/alerts/:id",
        {
            schema: {
                tags: ["Alerts"],
                summary: "Cancel a price alert",
                description: "Cancels an ACTIVE price alert. Idempotent — cancelling an already-cancelled alert returns success.",
                security: [{ bearerAuth: [] }],
                params: {
                    type: "object",
                    required: ["id"],
                    properties: { id: { type: "string", format: "uuid" } },
                },
                response: {
                    200: { type: "object", additionalProperties: true },
                    404: { type: "object", additionalProperties: true },
                },
            },
            preHandler: requireUser,
        },
        async (req, reply) => {
            try {
                const actor = req.user!;
                const { id } = req.params as { id: string };

                const alert = await cancelAlertByUser(actor.id, id);

                publishAlertUpdated(alert.id, alert.pair_id, "cancelled");

                return reply.send(alert);
            } catch (err) {
                return v1HandleError(reply, err);
            }
        }
    );
};

function publishAlertUpdated(alertId: string, pairId: string, action: "created" | "fired" | "cancelled" | "expired"): void {
    try {
        publish(createEvent("alert.updated", { alertId, pairId, action }));
    } catch {
        // Events must never break the request path
    }
}

export default v1Alerts;
