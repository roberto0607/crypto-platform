/**
 * v1Events.ts — GET /v1/events (Server-Sent Events stream).
 *
 * Streams typed events to authenticated clients via SSE.
 * Requires Bearer token. Sends heartbeat every 20s.
 */

import type { FastifyPluginAsync } from "fastify";
import { randomUUID } from "node:crypto";
import { requireUser } from "../../auth/requireUser";
import { subscribe, unsubscribe, type EventHandler } from "../../events/eventBus";
import type { AppEvent } from "../../events/eventTypes";
import { v1HandleError } from "../../http/v1Error";
import { AppError } from "../../errors/AppError";
import { leaveMatchSpectatorRoom } from "../../competitions/matchSpectatorSession";
import { logger as rootLogger } from "../../observability/logContext";
import {
  eventConnectionsActive,
  eventsDeliveryFailuresTotal,
} from "../../metrics";

const logger = rootLogger.child({ module: "v1Events" });

const HEARTBEAT_INTERVAL_MS = 15_000;
const PING_INTERVAL_MS = 15_000;

/**
 * Per-connection interest set — gates which pairIds a stream's price.tick/
 * candle.closed events are filtered to. Populated on connect (empty — no
 * symbol ticks until the client explicitly subscribes) and replaced wholesale
 * by POST /v1/events/subscribe. Every other event type (order/wallet/
 * trigger/notification/match/etc.) bypasses this filter entirely — only
 * symbol-scoped market-data events are gated. See docs/designs/2026-07-22-
 * multi-asset-datafeed-gate1.md section 3.
 */
const PAIR_SCOPED_EVENT_TYPES = new Set(["price.tick", "candle.closed"]);

interface StreamEntry {
  userId: string;
  interestSet: Set<string>;
  /** This stream's own EventHandler closure — needed so match-spectate
   * routes (in v1Matches.ts) can register/deregister it for match-room
   * delivery via eventBus's subscribeToMatch/unsubscribeFromMatch, without
   * duplicating the SSE connection machinery. */
  handler: EventHandler;
  /** matchId this stream is currently spectating, if any — tracked here so
   * disconnect cleanup can leave the spectator room without the client
   * having to call POST /unspectate first. */
  spectatingMatchId: string | null;
}

const streamInterestSets = new Map<string, StreamEntry>();

/**
 * True when `event` should be written to a stream with the given interest
 * set. Extracted as a pure function so the filtering decision is directly
 * unit-testable without a live SSE connection.
 */
export function shouldDeliverToStream(event: AppEvent, interestSet: Set<string>): boolean {
  if (!PAIR_SCOPED_EVENT_TYPES.has(event.type)) return true;
  const pairId = (event.data as { pairId?: string }).pairId;
  return !!pairId && interestSet.has(pairId);
}

/**
 * TEST-ONLY — do not call from production code paths.
 *
 * Lets route-level tests pre-populate a stream entry (as if a real SSE
 * connection had already sent its stream.ready frame) so POST
 * /events/subscribe's success path can be exercised via app.inject()
 * without opening a real long-lived SSE connection.
 */
export function __setStreamForTest(streamId: string, entry: StreamEntry): void {
  streamInterestSets.set(streamId, entry);
}

/** TEST-ONLY — see __setStreamForTest. */
export function __getStreamForTest(streamId: string): StreamEntry | undefined {
  return streamInterestSets.get(streamId);
}

/** TEST-ONLY — see __setStreamForTest. Resets all stream state between tests. */
export function __clearStreamsForTest(): void {
  streamInterestSets.clear();
}

/**
 * Look up a stream's own EventHandler, scoped to the requesting userId so a
 * spectate request can't address a connection it doesn't own. Returns null
 * for an unknown streamId or a streamId owned by a different user.
 */
export function getStreamHandler(streamId: string, userId: string): EventHandler | null {
  const entry = streamInterestSets.get(streamId);
  if (!entry || entry.userId !== userId) return null;
  return entry.handler;
}

/** Record which match (if any) a stream is currently spectating. */
export function setStreamSpectatingMatch(streamId: string, matchId: string | null): void {
  const entry = streamInterestSets.get(streamId);
  if (entry) entry.spectatingMatchId = matchId;
}

/** The matchId a stream is currently spectating, or null. */
export function getStreamSpectatingMatch(streamId: string): string | null {
  return streamInterestSets.get(streamId)?.spectatingMatchId ?? null;
}

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

    // `closed` ensures cleanup runs exactly once even if both the client-close
    // event and a heartbeat/ping write-failure trigger the cleanup path.
    // Without this guard the decrement on eventConnectionsActive would
    // double-fire and corrupt the metric.
    let closed = false;

    // Per-connection interest set for symbol-scoped events — starts empty
    // (no chart subscribed yet) and is replaced wholesale by
    // POST /v1/events/subscribe. streamId is handed to the client as the
    // very first frame so it can address this specific connection.
    const streamId = randomUUID();
    reply.raw.write(`event: stream.ready\ndata: ${JSON.stringify({ streamId })}\n\n`);

    // Event handler — writes SSE frames to the response. price.tick/
    // candle.closed are filtered to this stream's interest set; every other
    // event type always delivers.
    const handler: EventHandler = (event: AppEvent) => {
      if (closed) return;
      const interestSet = streamInterestSets.get(streamId)?.interestSet ?? new Set<string>();
      if (!shouldDeliverToStream(event, interestSet)) return;
      try {
        const frame = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
        reply.raw.write(frame);
      } catch {
        eventsDeliveryFailuresTotal.inc();
      }
    };

    streamInterestSets.set(streamId, { userId, interestSet: new Set(), handler, spectatingMatchId: null });

    // Subscribe for this user's events
    subscribe(userId, handler);

    // Heartbeat to keep connection alive (SSE comment — invisible to fetchEventSource)
    const heartbeat = setInterval(() => {
      if (closed) return;
      try {
        reply.raw.write(": heartbeat\n\n");
      } catch {
        cleanup();
      }
    }, HEARTBEAT_INTERVAL_MS);

    // Ping — typed SSE event the frontend can detect for liveness
    const ping = setInterval(() => {
      if (closed) return;
      try {
        const frame = `event: ping\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`;
        reply.raw.write(frame);
      } catch {
        cleanup();
      }
    }, PING_INTERVAL_MS);

    // Cleanup function — idempotent via the closed flag.
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      clearInterval(ping);
      unsubscribe(handler);
      // A spectator who just closes the tab/navigates away never calls POST
      // /unspectate — this is the only place that's guaranteed to run, so it
      // must independently leave the match room (unsubscribe already dropped
      // the eventBus registration; this also decrements the Redis/in-memory
      // spectator count and notifies the room + players of the new count).
      const spectatingMatchId = streamInterestSets.get(streamId)?.spectatingMatchId;
      if (spectatingMatchId) {
        leaveMatchSpectatorRoom(spectatingMatchId, userId, handler).catch((err) => {
          logger.warn({ err, matchId: spectatingMatchId, userId }, "spectator_disconnect_cleanup_failed");
        });
      }
      streamInterestSets.delete(streamId);
      eventConnectionsActive.dec();
    };

    // Handle client disconnect
    req.raw.on("close", cleanup);
  });

  // POST /events/subscribe — replace a stream's symbol interest set.
  // SSE is one-way, so a chart switching pairs calls this to tell the
  // server which pairIds it wants price.tick/candle.closed for. Replaces
  // (not merges) the set — the caller always sends its full desired set.
  app.post("/events/subscribe", {
    schema: {
      tags: ["Events"],
      summary: "Update an SSE stream's symbol interest set",
      description: "Replaces the pairIds this stream receives price.tick/candle.closed events for. streamId comes from the stream.ready frame sent on connect.",
      security: [{ bearerAuth: [] }],
      body: {
        type: "object",
        required: ["streamId", "pairIds"],
        properties: {
          streamId: { type: "string", format: "uuid" },
          pairIds: { type: "array", items: { type: "string", format: "uuid" } },
        },
      },
      response: {
        200: { type: "object", properties: { ok: { type: "boolean" } } },
      },
    },
    preHandler: requireUser,
  }, async (req, reply) => {
    try {
      const { streamId, pairIds } = req.body as { streamId: string; pairIds: string[] };
      const entry = streamInterestSets.get(streamId);
      if (!entry || entry.userId !== req.user!.id) {
        throw new AppError("stream_not_found");
      }
      entry.interestSet = new Set(pairIds);
      return reply.send({ ok: true });
    } catch (err) {
      return v1HandleError(reply, err);
    }
  });
};

export default v1Events;
