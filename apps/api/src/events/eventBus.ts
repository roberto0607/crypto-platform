/**
 * eventBus.ts — In-memory pub/sub event bus.
 *
 * Supports:
 *  - User-scoped subscriptions (events with matching userId)
 *  - Global broadcast (events without userId go to all)
 *  - Cleanup on unsubscribe (no memory leaks)
 */

import type { AppEvent } from "./eventTypes";

export type EventHandler = (event: AppEvent) => void;

/** Global handlers — receive ALL events regardless of userId. */
const globalHandlers = new Set<EventHandler>();

/** Per-user handlers — only receive events matching their userId. */
const userHandlers = new Map<string, Set<EventHandler>>();

/** Reverse lookup: handler → userId (for cleanup on unsubscribe). */
const handlerToUser = new Map<EventHandler, string>();

/**
 * Subscribe a handler for a specific user's events.
 * The handler will receive:
 *  - Events where event.userId matches the subscribed userId
 *  - Events where event.userId is undefined (broadcasts)
 */
export function subscribe(userId: string, handler: EventHandler): void {
  if (!userHandlers.has(userId)) {
    userHandlers.set(userId, new Set());
  }
  userHandlers.get(userId)!.add(handler);
  handlerToUser.set(handler, userId);
}

/**
 * Remove a handler from all subscriptions.
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
  globalHandlers.delete(handler);
}

/**
 * Publish an event to all matching subscribers.
 *
 * Routing rules:
 *  - If event.userId is set → deliver to that user's handlers
 *  - Always deliver to global handlers
 *
 * Errors in handlers are caught and logged (never propagate).
 */
export function publish(event: AppEvent): void {
  // Deliver to user-scoped handlers
  if (event.userId) {
    const handlers = userHandlers.get(event.userId);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(event);
        } catch {
          // Swallow — event delivery must not break callers
        }
      }
    }
  }

  // Deliver to global handlers
  for (const handler of globalHandlers) {
    try {
      handler(event);
    } catch {
      // Swallow
    }
  }
}

/**
 * Subscribe a global handler (receives ALL events).
 * Useful for metrics, logging, debugging.
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
