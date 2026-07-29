/**
 * matchEvents.ts — publish helper for match-scoped events that need to reach
 * both participants AND the match's live spectator room.
 */

import { publish } from "./eventBus.js";
import { createEvent, type AppEvent } from "./eventTypes.js";

interface MatchRef {
  id: string;
  challenger_id: string;
  opponent_id: string;
}

/**
 * Publish a match-scoped event to both participants (by userId) and to the
 * match's spectator room (by matchId), with exactly one delivery per
 * recipient. matchId is attached to only ONE of the two publish() calls —
 * deliverLocally treats userId and matchId as independently-additive target
 * sets, so tagging both calls with matchId would deliver the event twice to
 * every spectator (once per publish() call).
 */
export function publishMatchEvent<T extends AppEvent["type"]>(
  type: T,
  data: Extract<AppEvent, { type: T }>["data"],
  match: MatchRef,
): void {
  // `as any` bypasses a TS limitation, not a real type hole: distributive
  // conditional types (Extract<AppEvent, {type: T}>) don't re-resolve across
  // a second layer of generic forwarding, even though this function's own
  // signature already enforces type<->data correspondence for every caller.
  publish(createEvent(type, data as any, { userId: match.challenger_id }));
  publish(createEvent(type, data as any, { userId: match.opponent_id, matchId: match.id }));
}
