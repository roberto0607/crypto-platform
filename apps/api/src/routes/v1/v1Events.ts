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

const v1Events: FastifyPluginAsync = async (app) => {
  app.get("/events", { preHandler: requireUser }, async (req, reply) => {
    const userId = req.user!.id;

    // Set SSE headers
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

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

    // Heartbeat to keep connection alive
    const heartbeat = setInterval(() => {
      try {
        reply.raw.write(": heartbeat\n\n");
      } catch {
        cleanup();
      }
    }, HEARTBEAT_INTERVAL_MS);

    // Cleanup function
    const cleanup = () => {
      clearInterval(heartbeat);
      unsubscribe(handler);
      eventConnectionsActive.dec();
    };

    // Handle client disconnect
    req.raw.on("close", cleanup);
  });
};

export default v1Events;
