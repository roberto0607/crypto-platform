/**
 * logContext.ts — Structured log context builder + standalone logger.
 *
 * Provides a pino logger for service-layer code that doesn't have
 * access to Fastify's req.log. Also provides a context builder
 * to ensure consistent log fields.
 */

import pino from "pino";

export const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });

export interface LogContext {
  requestId: string;
  userId?: string;
  pairId?: string;
  orderId?: string;
  idempotencyKey?: string;
  eventType?: string;
}

/**
 * Build a structured log context, stripping undefined fields.
 */
export function buildLogContext(fields: {
  requestId: string;
  userId?: string;
  pairId?: string;
  orderId?: string;
  idempotencyKey?: string;
  eventType?: string;
}): LogContext {
  const ctx: LogContext = { requestId: fields.requestId };
  if (fields.userId !== undefined) ctx.userId = fields.userId;
  if (fields.pairId !== undefined) ctx.pairId = fields.pairId;
  if (fields.orderId !== undefined) ctx.orderId = fields.orderId;
  if (fields.idempotencyKey !== undefined) ctx.idempotencyKey = fields.idempotencyKey;
  if (fields.eventType !== undefined) ctx.eventType = fields.eventType;
  return ctx;
}
