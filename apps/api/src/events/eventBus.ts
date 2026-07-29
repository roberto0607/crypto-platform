/**
 * eventBus.ts — Pub/sub event bus with optional Redis cross-instance delivery.
 *
 * Supports:
 *  - User-scoped subscriptions (events with matching userId)
 *  - Global broadcast (events without userId go to all)
 *  - Cleanup on unsubscribe (no memory leaks)
 *  - Redis Pub/Sub for multi-instance deployments
 */

import { randomUUID } from "node:crypto";
import type { AppEvent } from "./eventTypes";
import { logger } from "../observability/logContext";
import { eventDeliveryLatency, eventsDeliveryFailuresTotal } from "../metrics";
import { getRedis, getRedisSub } from "../db/redis.js";

const CHANNEL = "cp:events";
const instanceId = randomUUID();

export type EventHandler = (event: AppEvent) => void;

/** Global handlers — receive ALL events regardless of userId. */
const globalHandlers = new Set<EventHandler>();

/** Per-user handlers — only receive events matching their userId. */
const userHandlers = new Map<string, Set<EventHandler>>();

/** Reverse lookup: handler → userId (for cleanup on unsubscribe). */
const handlerToUser = new Map<EventHandler, string>();

/**
 * Per-match handlers — spectator-room delivery. Independent, additive
 * targeting dimension alongside userId (see deliverLocally): an event with
 * both userId and matchId set delivers to both, deduplicated. A handler is
 * registered here explicitly (subscribeToMatch), not implicitly on connect
 * like userHandlers — a stream only joins a match room when the client
 * actually starts spectating that match.
 */
const matchHandlers = new Map<string, Set<EventHandler>>();

/** Reverse lookup: handler → matchId (for cleanup on unsubscribe/unsubscribeFromMatch). */
const handlerToMatch = new Map<EventHandler, string>();

// ── Local delivery (shared by direct publish + Redis incoming) ──

function deliverLocally(event: AppEvent): void {
  const deliveryStart = performance.now();

  // userId and matchId are independently-additive target sets, deduplicated
  // via this Set so a handler registered under both (e.g. a stream that
  // somehow matches its own userId target and its spectated matchId) is only
  // invoked once. Broadcast (neither set) is the "no explicit target"
  // fallback — unchanged from prior behavior since no existing call site
  // sets matchId.
  const recipients = new Set<EventHandler>();

  if (event.userId) {
    const handlers = userHandlers.get(event.userId);
    if (handlers) {
      for (const handler of handlers) recipients.add(handler);
    }
  }

  if (event.matchId) {
    const handlers = matchHandlers.get(event.matchId);
    if (handlers) {
      for (const handler of handlers) recipients.add(handler);
    }
  }

  if (!event.userId && !event.matchId) {
    for (const handlers of userHandlers.values()) {
      for (const handler of handlers) recipients.add(handler);
    }
  }

  for (const handler of recipients) {
    try {
      handler(event);
    } catch (err) {
      eventsDeliveryFailuresTotal.inc();
      logger.error({ eventType: "event.delivery_error", eventKind: event.type, userId: event.userId, matchId: event.matchId, err }, "Event handler error");
    }
  }

  for (const handler of globalHandlers) {
    try {
      handler(event);
    } catch (err) {
      eventsDeliveryFailuresTotal.inc();
      logger.error({ eventType: "event.delivery_error", eventKind: event.type, err }, "Global event handler error");
    }
  }

  eventDeliveryLatency.observe(performance.now() - deliveryStart);
}

// ── Public API ──

/**
 * Subscribe a handler for a specific user's events.
 */
export function subscribe(userId: string, handler: EventHandler): void {
  if (!userHandlers.has(userId)) {
    userHandlers.set(userId, new Set());
  }
  userHandlers.get(userId)!.add(handler);
  handlerToUser.set(handler, userId);
}

/**
 * Remove a handler from all subscriptions — user, match-room, and global.
 */
export function unsubscribe(handler: EventHandler): void {
  const userId = handlerToUser.get(handler);
  if (userId) {
    const set = userHandlers.get(userId);
    if (set) {
      set.delete(handler);
      if (set.size === 0) {
        userHandlers.delete(userId);
      }
    }
    handlerToUser.delete(handler);
  }
  unsubscribeFromMatch(handler);
  globalHandlers.delete(handler);
}

/**
 * Register a handler for a match's spectator-room events (in addition to
 * whatever userId-scoped subscription it already has). Moves the handler if
 * it was previously subscribed to a different match — a stream can only
 * spectate one match at a time.
 */
export function subscribeToMatch(matchId: string, handler: EventHandler): void {
  const existing = handlerToMatch.get(handler);
  if (existing && existing !== matchId) {
    unsubscribeFromMatch(handler);
  }
  if (!matchHandlers.has(matchId)) {
    matchHandlers.set(matchId, new Set());
  }
  matchHandlers.get(matchId)!.add(handler);
  handlerToMatch.set(handler, matchId);
}

/**
 * Remove a handler from whichever match room it's in, if any. Safe to call
 * on a handler that isn't in any room (no-op).
 */
export function unsubscribeFromMatch(handler: EventHandler): void {
  const matchId = handlerToMatch.get(handler);
  if (!matchId) return;
  const set = matchHandlers.get(matchId);
  if (set) {
    set.delete(handler);
    if (set.size === 0) {
      matchHandlers.delete(matchId);
    }
  }
  handlerToMatch.delete(handler);
}

/**
 * Publish an event to all matching subscribers.
 *
 * 1. Deliver to local handlers (synchronous)
 * 2. Publish to Redis channel for cross-instance delivery (fire-and-forget)
 */
export function publish(event: AppEvent): void {
  deliverLocally(event);

  const redis = getRedis();
  if (redis) {
    const envelope = JSON.stringify({ instanceId, event });
    redis.publish(CHANNEL, envelope).catch((err) => {
      logger.warn({ err }, "Redis event publish failed");
    });
  }
}

/**
 * Subscribe a global handler (receives ALL events).
 */
export function subscribeGlobal(handler: EventHandler): void {
  globalHandlers.add(handler);
}

/**
 * Get current connection counts (for metrics).
 */
export function getStats(): { userCount: number; handlerCount: number; globalCount: number } {
  let handlerCount = 0;
  for (const set of userHandlers.values()) {
    handlerCount += set.size;
  }
  return {
    userCount: userHandlers.size,
    handlerCount,
    globalCount: globalHandlers.size,
  };
}

// ── Redis Pub/Sub lifecycle ──

/**
 * Start listening for cross-instance events via Redis Pub/Sub.
 * No-op if Redis is not configured.
 */
export async function startEventBus(): Promise<void> {
  const sub = getRedisSub();
  if (!sub) return;

  sub.on("message", (channel: string, message: string) => {
    if (channel !== CHANNEL) return;
    try {
      const envelope = JSON.parse(message);
      if (envelope.instanceId === instanceId) return;
      deliverLocally(envelope.event as AppEvent);
    } catch (err) {
      logger.warn({ err }, "Failed to process Redis event message");
    }
  });

  await sub.subscribe(CHANNEL);
}

/**
 * Stop listening. No-op if Redis is not configured.
 */
export async function stopEventBus(): Promise<void> {
  const sub = getRedisSub();
  if (!sub) return;

  try {
    await sub.unsubscribe(CHANNEL);
  } catch {
    // Already disconnecting
  }
}
