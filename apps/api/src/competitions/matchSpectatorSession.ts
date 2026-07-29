/**
 * matchSpectatorSession.ts — join/leave a match's live spectator room.
 *
 * Centralizes the three things that must always happen together (register
 * for match-room event delivery, update the spectator count, notify
 * everyone who cares about the new count) so both the explicit POST
 * /matches/:id/spectate|unspectate routes and the SSE disconnect cleanup
 * path (a spectator who just closes the tab) share one implementation —
 * there is no second place this logic can drift out of sync.
 */

import type { EventHandler } from "../events/eventBus.js";
import { subscribeToMatch, unsubscribeFromMatch } from "../events/eventBus.js";
import { publishMatchEvent } from "../events/matchEvents.js";
import { addSpectator, removeSpectator } from "./matchSpectatorStore.js";
import { getMatchById } from "./matchService.js";
import { logger as rootLogger } from "../observability/logContext.js";

const logger = rootLogger.child({ module: "matchSpectatorSession" });

export async function joinMatchSpectatorRoom(
  matchId: string,
  userId: string,
  handler: EventHandler,
): Promise<number> {
  subscribeToMatch(matchId, handler);
  const count = await addSpectator(matchId, userId);
  const match = await getMatchById(matchId);
  if (match) {
    publishMatchEvent("match.spectator_count", { matchId, count }, match);
  }
  return count;
}

export async function leaveMatchSpectatorRoom(
  matchId: string,
  userId: string,
  handler: EventHandler,
): Promise<number> {
  unsubscribeFromMatch(handler);
  const count = await removeSpectator(matchId, userId);
  try {
    const match = await getMatchById(matchId);
    if (match) {
      publishMatchEvent("match.spectator_count", { matchId, count }, match);
    }
  } catch (err) {
    // Best-effort notification only — the spectator has already left
    // (unsubscribeFromMatch + removeSpectator above already completed), so a
    // failure here must not surface as an error to the caller (this runs
    // from the SSE disconnect path too, where there's no request to fail).
    logger.warn({ err, matchId, userId }, "spectator_count_notify_failed");
  }
  return count;
}
