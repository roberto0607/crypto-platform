/**
 * quickCallService.ts — "Where's BTC in 60 seconds?" calls.
 *
 * The server is the only source of prices and outcomes: entry is the latest
 * BTC/USD trade at receipt, exit is the latest trade when the call comes due.
 * The client supplies a direction and nothing else.
 */

import { randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import { publish } from "../events/eventBus";
import { createEvent } from "../events/eventTypes";
import { logger as rootLogger } from "../observability/logContext";
import { getLatestTrade, type LatestTrade } from "./latestTradeStore";
import {
  quickCallStore,
  type Direction,
  type OpenCall,
  type Outcome,
  type SettledCall,
} from "./quickCallStore";
import type { Identity } from "./identity";

const logger = rootLogger.child({ module: "quickCall" });

export const QUICK_CALL_SYMBOL = "BTC/USD";
export const CALL_DURATION_MS = 60_000;
export const MAX_FEED_AGE_MS = 5_000;
export const STREAK_CAP = 5;
export const IP_CALLS_PER_HOUR = 30;
/**
 * How late a settle may run and still use the live price. The in-process
 * timer fires within milliseconds of settleAt; anything later means that
 * timer was lost (instance restart) and there is no price at t+60 to use,
 * so the call is void rather than settled on a later price.
 */
export const SETTLE_GRACE_MS = 1_000;

/** Overridable in tests. */
export const clock = { now: () => Date.now() };
export const scheduler = {
  schedule(fn: () => void, delayMs: number): void {
    setTimeout(fn, delayMs).unref();
  },
};

export class QuickCallError extends Error {
  constructor(
    public code: "call_already_open" | "rate_limited" | "price_feed_stale",
    public statusCode: 409 | 429 | 503,
  ) {
    super(code);
  }
}

/**
 * The settle rule. Win when price moved the called way, push on an exact tie,
 * void when there's no exit price or the feed was stale (> 5s) at settle time.
 */
export function settleOutcome(
  direction: Direction,
  entryPrice: string,
  exit: LatestTrade | null,
  settleTime: number,
): Outcome {
  if (!exit || settleTime - exit.receivedAt > MAX_FEED_AGE_MS) return "VOID";
  const cmp = new Decimal(exit.price).cmp(new Decimal(entryPrice));
  if (cmp === 0) return "PUSH";
  return (cmp > 0) === (direction === "UP") ? "WIN" : "LOSS";
}

export function nextStreak(streak: number, outcome: Outcome): number {
  if (outcome === "WIN") return Math.min(streak + 1, STREAK_CAP);
  if (outcome === "LOSS") return 0;
  return streak;
}

/**
 * Settle `callId` if it's still the identity's open call and it's due.
 * Returns the settled call, or null if nothing was settled (not due, already
 * settled by someone else, or superseded).
 */
export async function settleCall(key: string, callId: string): Promise<SettledCall | null> {
  const store = quickCallStore();
  const call = await store.getOpen(key);
  if (!call || call.id !== callId) return null;

  const now = clock.now();
  if (now < call.settleAt) return null;

  const onTime = now - call.settleAt <= SETTLE_GRACE_MS;
  const exit = onTime ? getLatestTrade(QUICK_CALL_SYMBOL) : null;
  const outcome = settleOutcome(call.direction, call.entryPrice, exit, now);

  if (!(await store.claimOpen(key, call.id))) return null;

  const streak = nextStreak(await store.getStreak(key), outcome);
  await store.setStreak(key, streak);

  const settled: SettledCall = {
    id: call.id,
    direction: call.direction,
    entryPrice: call.entryPrice,
    exitPrice: outcome === "VOID" ? null : exit!.price,
    outcome,
    settledAt: now,
  };
  await store.pushHistory(key, settled);

  publish(createEvent("quickcall.settled", { ...settled, streak }, { userId: key }));
  return settled;
}

/** Settle an overdue call before reading/replacing it (covers a lost timer). */
async function settleIfDue(key: string): Promise<void> {
  const call = await quickCallStore().getOpen(key);
  if (call && clock.now() >= call.settleAt) await settleCall(key, call.id);
}

export async function placeCall(
  identity: Identity,
  direction: Direction,
  ip: string,
): Promise<{ call: OpenCall; streak: number }> {
  const store = quickCallStore();
  await settleIfDue(identity.key);
  if (await store.getOpen(identity.key)) throw new QuickCallError("call_already_open", 409);

  const now = clock.now();
  const entry = getLatestTrade(QUICK_CALL_SYMBOL);
  if (!entry || now - entry.receivedAt > MAX_FEED_AGE_MS) {
    throw new QuickCallError("price_feed_stale", 503);
  }

  if ((await store.incrIp(ip)) > IP_CALLS_PER_HOUR) throw new QuickCallError("rate_limited", 429);

  const call: OpenCall = {
    id: randomUUID(),
    direction,
    entryPrice: entry.price,
    entryAt: now,
    settleAt: now + CALL_DURATION_MS,
  };
  if (!(await store.setOpenIfAbsent(identity.key, call))) {
    throw new QuickCallError("call_already_open", 409);
  }

  scheduler.schedule(() => {
    settleCall(identity.key, call.id).catch((err) => {
      logger.error({ err, callId: call.id }, "quick_call_settle_failed");
    });
  }, CALL_DURATION_MS);

  return { call, streak: await store.getStreak(identity.key) };
}

export async function getCurrent(
  identity: Identity,
): Promise<{ call: OpenCall | null; streak: number; history: SettledCall[] }> {
  const store = quickCallStore();
  await settleIfDue(identity.key);
  const [call, streak, history] = await Promise.all([
    store.getOpen(identity.key),
    store.getStreak(identity.key),
    store.getHistory(identity.key),
  ]);
  return { call, streak, history };
}

/**
 * Move an anonymous session's streak onto a user (signup/login) and delete
 * the anon state. The user keeps the better of the two streaks.
 */
export async function transferStreak(fromKey: string, toKey: string): Promise<number> {
  const store = quickCallStore();
  const [anonStreak, userStreak] = await Promise.all([store.getStreak(fromKey), store.getStreak(toKey)]);
  const streak = Math.max(anonStreak, userStreak);
  if (streak > 0) await store.setStreak(toKey, streak);
  await store.deleteIdentity(fromKey);
  return streak;
}
