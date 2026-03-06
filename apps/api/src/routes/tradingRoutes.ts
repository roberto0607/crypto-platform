import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import { pool } from "../db/pool";
import { timedQuery } from "../observability/dbTiming";
import { requireUser } from "../auth/requireUser";
import { requireVerified } from "../auth/requireVerified";
import { auditLog } from "../audit/log";
import { handleError } from "../http/handleError";
import { findPairById, listActivePairs } from "../trading/pairRepo";
import { findOrderById, listOrdersByUserId } from "../trading/orderRepo";
import { listTradesByOrderId } from "../trading/tradeRepo";
import { cancelOrderWithOutbox } from "../trading/phase6OrderService";
import { enqueueOrder } from "../queue/queueManager";
import { enforcePreOrderChecks } from "../governance/quotaService";


// ── Zod schemas ──
const placeOrderBody = z.object({
  pairId: z.string().uuid(),
  side: z.enum(["BUY", "SELL"]),
  type: z.enum(["MARKET", "LIMIT"]),
  qty: z.string().regex(/^\d+(\.\d{1,8})?$/),
  limitPrice: z.string().regex(/^\d+(\.\d{1,8})?$/).optional(),
}).refine(
  (data) => {
    if (data.type === "LIMIT" && !data.limitPrice) return false;
    if (data.type === "MARKET" && data.limitPrice) return false;
    return true;
  },
  { message: "limitPrice required for LIMIT orders, forbidden for MARKET orders" }
);

const orderIdParams = z.object({ id: z.string().uuid() });

const listOrdersQuery = z.object({
  pairId: z.string().uuid().optional(),
  status: z.string().optional(),
});

const pairIdParams = z.object({ id: z.string().uuid() });

const bookQuery = z.object({
  levels: z.coerce.number().int().min(1).max(100).default(20),
});

// ── Plugin (registered without prefix) ──
const tradingRoutes: FastifyPluginAsync = async (app) => {

  // GET /pairs — List active pairs
  app.get("/pairs", { preHandler: requireUser }, async (req, reply) => {
    const pairs = await listActivePairs();
    return reply.send({ ok: true, pairs });
  });

  // POST /orders — Place order (matching-lite) — rate limit: 60/min per IP
  app.post("/orders", { preHandler: [requireUser, requireVerified], config: { rateLimit: { max: 60, timeWindow: 60_000 } } }, async (req, reply) => {
    const parsed = placeOrderBody.safeParse(req.body);
    if (!parsed.success) {
        return reply.code(400).send({ ok: false, error: "invalid_input", details: parsed.error.flatten() });
    }

    const actor = req.user!;

        try {
        // ── PR6: Pre-order enforcement layer ──
        await enforcePreOrderChecks(actor.id, parsed.data.pairId);

        const idempotencyKey = req.headers["idempotency-key"] as string | undefined;

        const result = await enqueueOrder(
            parsed.data.pairId,
            actor.id,
            {
                pairId: parsed.data.pairId,
                side: parsed.data.side,
                type: parsed.data.type,
                qty: parsed.data.qty,
                limitPrice: parsed.data.limitPrice,
            },
            idempotencyKey,
            req.id as string,
        );

        if (!result.fromIdempotencyCache) {
            await auditLog({
                actorUserId: actor.id,
                action: "order.create",
                targetType: "order",
                targetId: result.order.id,
                requestId: req.id,
                ip: req.ip,
                userAgent: req.headers["user-agent"] ?? null,
                metadata: {
                    orderId: result.order.id,
                    pairId: parsed.data.pairId,
                    side: parsed.data.side,
                    type: parsed.data.type,
                    qty: parsed.data.qty,
                    limitPrice: parsed.data.limitPrice ?? null,
                    status: result.order.status,
                    fillCount: result.fills.length,
                },
            });
        }

        return reply.code(201).send({ ok: true, order: result.order, fills: result.fills });
    } catch (err) {
        return handleError(reply, err);
    }

           
  });

  // GET /orders — List user's orders
  app.get("/orders", { preHandler: requireUser }, async (req, reply) => {
    const actor = req.user!;
    const queryParsed = listOrdersQuery.safeParse(req.query);
    const filters = queryParsed.success ? queryParsed.data : {};
    const orders = await listOrdersByUserId(actor.id, filters);
    return reply.send({ ok: true, orders });
  });

  // GET /orders/:id — Order detail + fills
  app.get("/orders/:id", { preHandler: requireUser }, async (req, reply) => {
    const paramsParsed = orderIdParams.safeParse(req.params);
    if (!paramsParsed.success) {
        return reply.code(400).send({ ok: false, error: "invalid_input", details: paramsParsed.error.flatten() });
    }

    const order = await findOrderById(paramsParsed.data.id);
    if (!order) {
        return reply.code(404).send({ ok: false, error: "order_not_found" });
    }

    const actor = req.user!;
    if (order.user_id !== actor.id) {
        return reply.code(403).send({ ok: false, error: "forbidden" });
    }

    const trades = await listTradesByOrderId(order.id);
    return reply.send({ ok: true, order, trades });
  });

  // DELETE /orders/:id — Cancel open/partial order
  app.delete("/orders/:id", { preHandler: [requireUser, requireVerified] }, async (req, reply) => {
    const paramsParsed = orderIdParams.safeParse(req.params);
    if (!paramsParsed.success) {
        return reply.code(400).send({ ok: false, error: "invalid_input", details: paramsParsed.error.flatten() });
    }

    const actor = req.user!;

    try {
        const result = await cancelOrderWithOutbox(actor.id, paramsParsed.data.id, req.id);

        await auditLog({
            actorUserId: actor.id,
            action: "order.cancel",
            targetType: "order",
            targetId: paramsParsed.data.id,
            requestId: req.id,
            ip: req.ip,
            userAgent: req.headers["user-agent"] ?? null,
            metadata: { orderId: paramsParsed.data.id, pairId: result.order.pair_id, releasedAmount: result.releasedAmount },
        });

        return reply.send({ ok: true, order: result.order, releasedAmount: result.releasedAmount });
    } catch (err) {
        return handleError(reply, err);
    }
  });

  // GET /pairs/:id/book — Aggregated order book
  app.get("/pairs/:id/book", { preHandler: requireUser }, async (req, reply) => {
    const paramsParsed = pairIdParams.safeParse(req.params);
    if (!paramsParsed.success) {
        return reply.code(400).send({ ok: false, error: "invalid_input", details: paramsParsed.error.flatten() });
    }

    const pair = await findPairById(paramsParsed.data.id);
    if (!pair) {
        return reply.code(404).send({ ok: false, error: "pair_not_found" });
    }

    const queryParsed = bookQuery.safeParse(req.query);
    const levels = queryParsed.success ? queryParsed.data.levels : 20;

    const [bidsResult, asksResult] = await Promise.all([
        timedQuery<{ price: string; qty: string; count: string }>(
            pool, "book.bids",
            `SELECT limit_price AS price,
                    SUM(qty - qty_filled)::text AS qty,
                    COUNT(*)::text AS count
             FROM orders
             WHERE pair_id = $1
               AND side = 'BUY'
               AND type = 'LIMIT'
               AND status IN ('OPEN', 'PARTIALLY_FILLED')
             GROUP BY limit_price
             ORDER BY limit_price DESC
             LIMIT $2`,
            [paramsParsed.data.id, levels]
        ),
        timedQuery<{ price: string; qty: string; count: string }>(
            pool, "book.asks",
            `SELECT limit_price AS price,
                    SUM(qty - qty_filled)::text AS qty,
                    COUNT(*)::text AS count
             FROM orders
             WHERE pair_id = $1
               AND side = 'SELL'
               AND type = 'LIMIT'
               AND status IN ('OPEN', 'PARTIALLY_FILLED')
             GROUP BY limit_price
             ORDER BY limit_price ASC
             LIMIT $2`,
            [paramsParsed.data.id, levels]
        ),
    ]);

    return reply.send({
        ok: true,
        book: { bids: bidsResult.rows, asks: asksResult.rows },
    });
  });
};

export default tradingRoutes;
