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
  app.get("/pairs", {
    schema: {
      tags: ["Pairs"],
      summary: "List active trading pairs",
      description: "Returns all active trading pairs with base/quote asset info.",
      security: [{ bearerAuth: [] }],
      response: {
        200: {
          type: "object",
          properties: {
            ok: { type: "boolean", const: true },
            pairs: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string", format: "uuid" },
                  base_asset_id: { type: "string", format: "uuid" },
                  quote_asset_id: { type: "string", format: "uuid" },
                  symbol: { type: "string" },
                  status: { type: "string", enum: ["ACTIVE", "INACTIVE"] },
                },
              },
            },
          },
        },
      },
    },
    preHandler: requireUser,
  }, async (req, reply) => {
    const pairs = await listActivePairs();
    return reply.send({ ok: true, pairs });
  });

  // POST /orders — Place order (matching-lite) — rate limit: 60/min per IP
  app.post("/orders", {
    schema: {
      tags: ["Trading"],
      summary: "Place a new order",
      description: "**Rate limit:** 60 requests per minute per IP.\n\nPlaces a BUY or SELL order. Supports MARKET and LIMIT types. Send `Idempotency-Key` header for exactly-once semantics. Subject to pre-order governance checks (quotas, risk, circuit breakers).",
      security: [{ bearerAuth: [] }],
      headers: {
        type: "object",
        properties: {
          "idempotency-key": { type: "string", description: "Idempotency key for exactly-once order placement" },
        },
      },
      body: {
        type: "object",
        required: ["pairId", "side", "type", "qty"],
        properties: {
          pairId: { type: "string", format: "uuid", description: "Trading pair ID" },
          side: { type: "string", enum: ["BUY", "SELL"] },
          type: { type: "string", enum: ["MARKET", "LIMIT"] },
          qty: { type: "string", pattern: "^\\d+(\\.\\d{1,8})?$", description: "Order quantity (decimal string, up to 8 decimals)" },
          limitPrice: { type: "string", pattern: "^\\d+(\\.\\d{1,8})?$", description: "Required for LIMIT orders, forbidden for MARKET orders" },
        },
      },
      response: {
        201: {
          type: "object",
          properties: {
            ok: { type: "boolean", const: true },
            order: {
              type: "object",
              additionalProperties: true,
              properties: {
                id: { type: "string", format: "uuid" },
                pair_id: { type: "string", format: "uuid" },
                user_id: { type: "string", format: "uuid" },
                side: { type: "string", enum: ["BUY", "SELL"] },
                type: { type: "string", enum: ["MARKET", "LIMIT"] },
                status: { type: "string", enum: ["OPEN", "FILLED", "PARTIALLY_FILLED", "CANCELLED"] },
                qty: { type: "string" },
                qty_filled: { type: "string" },
                limit_price: { type: "string", nullable: true },
              },
            },
            fills: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: true,
                properties: {
                  id: { type: "string", format: "uuid" },
                  price: { type: "string" },
                  qty: { type: "string" },
                },
              },
            },
          },
        },
        400: {
          type: "object",
          properties: {
            ok: { type: "boolean", const: false },
            error: { type: "string", enum: ["invalid_input", "insufficient_balance", "risk_check_failed", "governance_check_failed", "trading_paused_global", "trading_paused_pair", "quota_exceeded"] },
            details: { type: "object", additionalProperties: true },
          },
        },
        409: {
          type: "object",
          properties: {
            ok: { type: "boolean", const: false },
            error: { type: "string", enum: ["idempotency_conflict"] },
          },
        },
        503: {
          type: "object",
          properties: {
            ok: { type: "boolean", const: false },
            error: { type: "string", enum: ["pair_queue_overloaded"] },
          },
        },
      },
    },
    preHandler: [requireUser, requireVerified],
    config: { rateLimit: { max: 60, timeWindow: 60_000 } },
  }, async (req, reply) => {
    const parsed = placeOrderBody.safeParse(req.body);
    if (!parsed.success) {
        return reply.code(400).send({ ok: false, error: "invalid_input", details: parsed.error.flatten() });
    }

    const actor = req.user!;

        try {
        // ── PR6: Pre-order enforcement layer ──
        await enforcePreOrderChecks(actor.id, parsed.data.pairId);

        const idempotencyKey = req.headers["idempotency-key"] as string | undefined;
        const competitionId = req.headers["x-competition-id"] as string | undefined;

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
            undefined,
            competitionId,
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
  app.get("/orders", {
    schema: {
      tags: ["Trading"],
      summary: "List user's orders",
      description: "Returns all orders for the authenticated user. Optionally filter by pair or status.",
      security: [{ bearerAuth: [] }],
      querystring: {
        type: "object",
        properties: {
          pairId: { type: "string", format: "uuid", description: "Filter by trading pair" },
          status: { type: "string", description: "Filter by order status (e.g. OPEN, FILLED, CANCELLED)" },
        },
      },
      response: {
        200: {
          type: "object",
          properties: {
            ok: { type: "boolean", const: true },
            orders: { type: "array", items: { type: "object", additionalProperties: true } },
          },
        },
      },
    },
    preHandler: requireUser,
  }, async (req, reply) => {
    const actor = req.user!;
    const queryParsed = listOrdersQuery.safeParse(req.query);
    const filters = queryParsed.success ? queryParsed.data : {};
    const orders = await listOrdersByUserId(actor.id, filters);
    return reply.send({ ok: true, orders });
  });

  // GET /orders/:id — Order detail + fills
  app.get("/orders/:id", {
    schema: {
      tags: ["Trading"],
      summary: "Get order detail with trades",
      description: "Returns a single order and its associated trade fills. Only the order owner can access.",
      security: [{ bearerAuth: [] }],
      params: {
        type: "object",
        required: ["id"],
        properties: {
          id: { type: "string", format: "uuid", description: "Order ID" },
        },
      },
      response: {
        200: {
          type: "object",
          properties: {
            ok: { type: "boolean", const: true },
            order: { type: "object", additionalProperties: true },
            trades: { type: "array", items: { type: "object", additionalProperties: true } },
          },
        },
        400: {
          type: "object",
          properties: {
            ok: { type: "boolean", const: false },
            error: { type: "string", enum: ["invalid_input"] },
            details: { type: "object", additionalProperties: true },
          },
        },
        403: {
          type: "object",
          properties: {
            ok: { type: "boolean", const: false },
            error: { type: "string", enum: ["forbidden"] },
          },
        },
        404: {
          type: "object",
          properties: {
            ok: { type: "boolean", const: false },
            error: { type: "string", enum: ["order_not_found"] },
          },
        },
      },
    },
    preHandler: requireUser,
  }, async (req, reply) => {
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
  app.delete("/orders/:id", {
    schema: {
      tags: ["Trading"],
      summary: "Cancel an open order",
      description: "Cancels an OPEN or PARTIALLY_FILLED order and releases the reserved balance.",
      security: [{ bearerAuth: [] }],
      params: {
        type: "object",
        required: ["id"],
        properties: {
          id: { type: "string", format: "uuid", description: "Order ID to cancel" },
        },
      },
      response: {
        200: {
          type: "object",
          properties: {
            ok: { type: "boolean", const: true },
            order: { type: "object", additionalProperties: true },
            releasedAmount: { type: "string", description: "Amount released back to available balance" },
          },
        },
        400: {
          type: "object",
          properties: {
            ok: { type: "boolean", const: false },
            error: { type: "string", enum: ["order_not_cancelable"] },
          },
        },
        404: {
          type: "object",
          properties: {
            ok: { type: "boolean", const: false },
            error: { type: "string", enum: ["order_not_found"] },
          },
        },
      },
    },
    preHandler: [requireUser, requireVerified],
  }, async (req, reply) => {
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
  app.get("/pairs/:id/book", {
    schema: {
      tags: ["Pairs"],
      summary: "Get order book for a trading pair",
      description: "Returns aggregated bid and ask levels for the specified trading pair. Each level shows the price, total quantity, and number of orders.",
      security: [{ bearerAuth: [] }],
      params: {
        type: "object",
        required: ["id"],
        properties: {
          id: { type: "string", format: "uuid", description: "Trading pair ID" },
        },
      },
      querystring: {
        type: "object",
        properties: {
          levels: { type: "integer", minimum: 1, maximum: 100, default: 20, description: "Number of price levels to return (default 20)" },
        },
      },
      response: {
        200: {
          type: "object",
          properties: {
            ok: { type: "boolean", const: true },
            book: {
              type: "object",
              properties: {
                bids: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      price: { type: "string" },
                      qty: { type: "string" },
                      count: { type: "string" },
                    },
                  },
                },
                asks: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      price: { type: "string" },
                      qty: { type: "string" },
                      count: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
        400: {
          type: "object",
          properties: {
            ok: { type: "boolean", const: false },
            error: { type: "string", enum: ["invalid_input"] },
            details: { type: "object", additionalProperties: true },
          },
        },
        404: {
          type: "object",
          properties: {
            ok: { type: "boolean", const: false },
            error: { type: "string", enum: ["pair_not_found"] },
          },
        },
      },
    },
    preHandler: requireUser,
  }, async (req, reply) => {
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
