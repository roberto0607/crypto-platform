/**
 * eventBus.matchRoom.test.ts — matchId-scoped delivery for the spectate
 * feature (Gate 1). Pure unit tests against the module-level eventBus state;
 * no DB/Redis needed.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  subscribe,
  unsubscribe,
  subscribeToMatch,
  unsubscribeFromMatch,
  publish,
} from "../eventBus";
import type { EventHandler } from "../eventBus";
import { createEvent } from "../eventTypes";
import type { AppEvent } from "../eventTypes";

const MATCH_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const MATCH_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const CHALLENGER = "11111111-1111-1111-1111-111111111111";
const OPPONENT = "22222222-2222-2222-2222-222222222222";
const SPECTATOR = "33333333-3333-3333-3333-333333333333";

function capture(): { events: AppEvent[]; handler: EventHandler } {
  const events: AppEvent[] = [];
  return { events, handler: (e) => events.push(e) };
}

describe("eventBus — matchId-scoped delivery", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const fn of cleanups.splice(0)) fn();
  });

  it("delivers a matchId-tagged event to a match-room subscriber even without a matching userId", () => {
    const outsider = capture();
    subscribeToMatch(MATCH_A, outsider.handler);
    cleanups.push(() => unsubscribeFromMatch(outsider.handler));

    publish(createEvent("match.pnl.update", {
      matchId: MATCH_A, challengerPnlPct: "1.5", opponentPnlPct: "-1.5",
    }, { userId: CHALLENGER, matchId: MATCH_A }));

    expect(outsider.events).toHaveLength(1);
  });

  it("does not deliver to a different match's room", () => {
    const watcher = capture();
    subscribeToMatch(MATCH_B, watcher.handler);
    cleanups.push(() => unsubscribeFromMatch(watcher.handler));

    publish(createEvent("match.pnl.update", {
      matchId: MATCH_A, challengerPnlPct: "1.5", opponentPnlPct: "-1.5",
    }, { userId: CHALLENGER, matchId: MATCH_A }));

    expect(watcher.events).toHaveLength(0);
  });

  it("delivers exactly once to a handler subscribed to both the target userId and the target matchId", () => {
    const dual = capture();
    subscribe(SPECTATOR, dual.handler);
    subscribeToMatch(MATCH_A, dual.handler);
    cleanups.push(() => unsubscribe(dual.handler));

    // Tag the event with SPECTATOR's own userId AND matchId — a contrived
    // case (a spectator is never also the userId target in practice), but
    // it's exactly the dedup path deliverLocally's recipients Set exists for.
    publish(createEvent("match.pnl.update", {
      matchId: MATCH_A, challengerPnlPct: "1.5", opponentPnlPct: "-1.5",
    }, { userId: SPECTATOR, matchId: MATCH_A }));

    expect(dual.events).toHaveLength(1);
  });

  it("does not double-deliver when two publish() calls target the same matchId (the publishMatchEvent pattern)", () => {
    const spectator = capture();
    subscribeToMatch(MATCH_A, spectator.handler);
    cleanups.push(() => unsubscribeFromMatch(spectator.handler));

    // Mirrors matchEvents.ts's publishMatchEvent: matchId attached to only
    // ONE of the two per-participant publish() calls.
    const data = { matchId: MATCH_A, challengerPnlPct: "1.5", opponentPnlPct: "-1.5" };
    publish(createEvent("match.pnl.update", data, { userId: CHALLENGER }));
    publish(createEvent("match.pnl.update", data, { userId: OPPONENT, matchId: MATCH_A }));

    expect(spectator.events).toHaveLength(1);
  });

  it("unsubscribe() (full connection cleanup) also removes the handler from its match room", () => {
    const watcher = capture();
    subscribe(SPECTATOR, watcher.handler);
    subscribeToMatch(MATCH_A, watcher.handler);

    unsubscribe(watcher.handler);

    publish(createEvent("match.pnl.update", {
      matchId: MATCH_A, challengerPnlPct: "1.5", opponentPnlPct: "-1.5",
    }, { userId: CHALLENGER, matchId: MATCH_A }));

    expect(watcher.events).toHaveLength(0);
  });

  it("subscribeToMatch moves a handler from its previous match room when it switches matches", () => {
    const watcher = capture();
    subscribeToMatch(MATCH_A, watcher.handler);
    subscribeToMatch(MATCH_B, watcher.handler);
    cleanups.push(() => unsubscribeFromMatch(watcher.handler));

    publish(createEvent("match.pnl.update", {
      matchId: MATCH_A, challengerPnlPct: "1.5", opponentPnlPct: "-1.5",
    }, { userId: CHALLENGER, matchId: MATCH_A }));
    expect(watcher.events).toHaveLength(0);

    publish(createEvent("match.pnl.update", {
      matchId: MATCH_B, challengerPnlPct: "1.5", opponentPnlPct: "-1.5",
    }, { userId: CHALLENGER, matchId: MATCH_B }));
    expect(watcher.events).toHaveLength(1);
  });

  it("existing userId-only and broadcast delivery are unaffected by matchId routing", () => {
    const perUser = capture();
    subscribe(OPPONENT, perUser.handler);
    cleanups.push(() => unsubscribe(perUser.handler));

    publish(createEvent("match.started", {
      matchId: MATCH_A, challengerId: CHALLENGER, opponentId: OPPONENT,
      duration: 24, startedAt: new Date().toISOString(),
    }, { userId: OPPONENT }));

    expect(perUser.events).toHaveLength(1);
  });
});
