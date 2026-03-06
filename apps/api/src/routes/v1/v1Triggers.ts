import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import crypto from "node:crypto";

import { requireUser } from "../../auth/requireUser";
import { v1HandleError } from "../../http/v1Error";
import { decodeCursor, parseLimit, slicePage } from "../../http/pagination";
import {
    createTriggerOrder,
    listTriggersByUser,
    cancelTriggerByUser,
} from "../../triggers/triggerRepo";
import { AppError } from "../../errors/AppError";
import type { TriggerOrderRow } from "../../triggers/triggerTypes";

const decimalStr = z.string().regex(/^\d+(\.\d{1,8})?$/);

const createTriggerBody = z
    .object({
        pairId: z.string().uuid(),
        kind: z.enum([
            "STOP_MARKET",
            "STOP_LIMIT",
            "TAKE_PROFIT_MARKET",
            "TAKE_PROFIT_LIMIT",
        ]),
        side: z.enum(["BUY", "SELL"]),
        triggerPrice: decimalStr,
        limitPrice: decimalStr.optional(),
        qty: decimalStr,
    })
    .refine(
        (d) => {
            if (d.kind.endsWith("_LIMIT") && !d.limitPrice) return false;
            if (d.kind.endsWith("_MARKET") && d.limitPrice) return false;
            return true;
        },
        {
            message:
                "limitPrice required for *_LIMIT kinds, forbidden for *_MARKET kinds",
        }
    );

const listTriggersQuery = z.object({
    pairId: z.string().uuid().optional(),
    status: z.string().optional(),
    limit: z.string().optional(),
    cursor: z.string().optional(),
});

const triggerLeg = z
    .object({
        kind: z.enum([
            "STOP_MARKET",
            "STOP_LIMIT",
            "TAKE_PROFIT_MARKET",
            "TAKE_PROFIT_LIMIT",
        ]),
        side: z.enum(["BUY", "SELL"]),
        triggerPrice: decimalStr,
        limitPrice: decimalStr.optional(),
        qty: decimalStr,
    })
    .refine(
        (d) => {
            if (d.kind.endsWith("_LIMIT") && !d.limitPrice) return false;
            if (d.kind.endsWith("_MARKET") && d.limitPrice) return false;
            return true;
        },
        {
            message:
                "limitPrice required for *_LIMIT kinds, forbidden for *_MARKET kinds",
        }
    );

const createOcoBody = z.object({
    pairId: z.string().uuid(),
    legA: triggerLeg,
    legB: triggerLeg,
});

const v1Triggers: FastifyPluginAsync = async (app) => {
    // POST /v1/triggers — create a single trigger order
    app.post("/triggers", {
        schema: {
            tags: ["Triggers"],
            summary: "Create a trigger order",
            description: "Creates a conditional trigger order (stop-loss or take-profit). Fires automatically when the trigger price is reached.",
            security: [{ bearerAuth: [] }],
            body: {
                type: "object",
                required: ["pairId", "kind", "side", "triggerPrice", "qty"],
                properties: {
                    pairId: { type: "string", format: "uuid" },
                    kind: { type: "string", enum: ["STOP_MARKET", "STOP_LIMIT", "TAKE_PROFIT_MARKET", "TAKE_PROFIT_LIMIT"] },
                    side: { type: "string", enum: ["BUY", "SELL"] },
                    triggerPrice: { type: "string", pattern: "^\\d+(\\.\\d{1,8})?$" },
                    limitPrice: { type: "string", pattern: "^\\d+(\\.\\d{1,8})?$", description: "Required for *_LIMIT kinds, forbidden for *_MARKET kinds" },
                    qty: { type: "string", pattern: "^\\d+(\\.\\d{1,8})?$" },
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
            const parsed = createTriggerBody.safeParse(req.body);
            if (!parsed.success) {
                throw new AppError("invalid_input", parsed.error.flatten());
            }
            const b = parsed.data;

            const trigger = await createTriggerOrder({
                userId: actor.id,
                pairId: b.pairId,
                kind: b.kind,
                side: b.side,
                triggerPrice: b.triggerPrice,
                limitPrice: b.limitPrice,
                qty: b.qty,
            });

            return reply.code(201).send(trigger);
        } catch (err) {
            return v1HandleError(reply, err);
        }
    });

    // GET /v1/triggers — list user's trigger orders (paginated)
    app.get("/triggers", {
        schema: {
            tags: ["Triggers"],
            summary: "List trigger orders (paginated)",
            description: "Returns paginated trigger orders for the authenticated user. Filter by pair or status.",
            security: [{ bearerAuth: [] }],
            querystring: {
                type: "object",
                properties: {
                    pairId: { type: "string", format: "uuid" },
                    status: { type: "string", description: "Filter by trigger status (ACTIVE, FIRED, CANCELLED)" },
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
            const queryParsed = listTriggersQuery.safeParse(req.query);
            const q = queryParsed.success ? queryParsed.data : {};

            const limit = parseLimit(q.limit);
            const cursor = decodeCursor<{ ca: string; id: string }>(q.cursor);

            const rows = await listTriggersByUser(
                actor.id,
                { pairId: q.pairId, status: q.status },
                limit,
                cursor,
            );

            const page = slicePage(rows, limit, (row: TriggerOrderRow) => ({
                ca: row.created_at,
                id: row.id,
            }));

            return reply.send(page);
        } catch (err) {
            return v1HandleError(reply, err);
        }
    });

    // DELETE /v1/triggers/:id — cancel an ACTIVE trigger (idempotent)
    app.delete(
        "/triggers/:id",
        {
            schema: {
                tags: ["Triggers"],
                summary: "Cancel a trigger order",
                description: "Cancels an ACTIVE trigger order. Idempotent — cancelling an already-cancelled trigger returns success.",
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

                const trigger = await cancelTriggerByUser(actor.id, id);

                return reply.send(trigger);
            } catch (err) {
                return v1HandleError(reply, err);
            }
        }
    );

    // POST /v1/oco — create an OCO pair (two linked triggers)
    app.post("/oco", {
        schema: {
            tags: ["Triggers"],
            summary: "Create an OCO (One-Cancels-Other) pair",
            description: "Creates two linked trigger orders. When one fires, the other is automatically cancelled.",
            security: [{ bearerAuth: [] }],
            body: {
                type: "object",
                required: ["pairId", "legA", "legB"],
                properties: {
                    pairId: { type: "string", format: "uuid" },
                    legA: { type: "object", description: "First trigger leg" },
                    legB: { type: "object", description: "Second trigger leg" },
                },
            },
            response: {
                201: {
                    type: "object",
                    properties: {
                        ocoGroupId: { type: "string", format: "uuid" },
                        legA: { type: "object", additionalProperties: true },
                        legB: { type: "object", additionalProperties: true },
                    },
                },
                400: { type: "object", additionalProperties: true },
            },
        },
        preHandler: requireUser,
    }, async (req, reply) => {
        try {
            const actor = req.user!;
            const parsed = createOcoBody.safeParse(req.body);
            if (!parsed.success) {
                throw new AppError("invalid_input", parsed.error.flatten());
            }
            const b = parsed.data;

            const ocoGroupId = crypto.randomUUID();

            const legA = await createTriggerOrder({
                userId: actor.id,
                pairId: b.pairId,
                kind: b.legA.kind,
                side: b.legA.side,
                triggerPrice: b.legA.triggerPrice,
                limitPrice: b.legA.limitPrice,
                qty: b.legA.qty,
                ocoGroupId,
            });

            const legB = await createTriggerOrder({
                userId: actor.id,
                pairId: b.pairId,
                kind: b.legB.kind,
                side: b.legB.side,
                triggerPrice: b.legB.triggerPrice,
                limitPrice: b.legB.limitPrice,
                qty: b.legB.qty,
                ocoGroupId,
            });

            return reply.code(201).send({ ocoGroupId, legA, legB });
        } catch (err) {
            return v1HandleError(reply, err);
        }
    });
};

export default v1Triggers;
