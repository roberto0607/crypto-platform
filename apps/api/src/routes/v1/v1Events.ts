/**
 * v1Events.ts — GET /v1/events (Server-Sent Events stream).
 *
 * Streams typed events to authenticated clients via SSE.
 * Requires Bearer token. Sends heartbeat every 20s.
 */

import type { FastifyPluginAsync } from "fastify";
import { requireUser } from "../../auth/requireUser";
import { subscribe, unsubscribe, type EventHandler } from "../../events/eventBus";
import type { AppEvent } from "../../events/eventTypes";
import {
  eventConnectionsActive,
  eventsDeliveryFailuresTotal,
} from "../../metrics";

const HEARTBEAT_INTERVAL_MS = 20_000;
const PING_INTERVAL_MS = 5_000;

const v1Events: FastifyPluginAsync = async (app) => {
  app.get("/events", {
    schema: {
      tags: ["Events"],
      summary: "Server-Sent Events stream",
      description: "Real-time event stream. Events: order.updated, trade.created, wallet.updated, price.tick, replay.tick, trigger.fired, trigger.canceled. Sends heartbeat every 20s.",
      security: [{ bearerAuth: [] }],
      response: {
        200: {
          description: "SSE event stream (text/event-stream)",
          type: "string",
        },
      },
    },
    preHandler: requireUser,
  }, async (req, reply) => {
    const userId = req.user!.id;

    // Set SSE headers via Fastify so CORS headers are preserved
    reply.header("Content-Type", "text/event-stream");
    reply.header("Cache-Control", "no-cache");
    reply.header("Connection", "keep-alive");
    reply.header("X-Accel-Buffering", "no");
    reply.raw.writeHead(200, reply.getHeaders() as import("node:http").OutgoingHttpHeaders);

    // Track active connections
    eventConnectionsActive.inc();

    // Event handler — writes SSE frames to the response
    const handler: EventHandler = (event: AppEvent) => {
      try {
        const frame = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
        reply.raw.write(frame);
      } catch {
        eventsDeliveryFailuresTotal.inc();
      }
    };

    // Subscribe for this user's events
    subscribe(userId, handler);

    // Heartbeat to keep connection alive (SSE comment — invisible to fetchEventSource)
    const heartbeat = setInterval(() => {
      try {
        reply.raw.write(": heartbeat\n\n");
      } catch {
        cleanup();
      }
    }, HEARTBEAT_INTERVAL_MS);

    // Ping — typed SSE event the frontend can detect for liveness
    const ping = setInterval(() => {
      try {
        const frame = `event: ping\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`;
        reply.raw.write(frame);
      } catch {
        cleanup();
      }
    }, PING_INTERVAL_MS);

    // Cleanup function
    const cleanup = () => {
      clearInterval(heartbeat);
      clearInterval(ping);
      unsubscribe(handler);
      eventConnectionsActive.dec();
    };

    // Handle client disconnect
    req.raw.on("close", cleanup);
  });
};

export default v1Events;
