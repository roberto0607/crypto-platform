/**
 * latestTradeStore.ts — the most recent trade price for BTC/ETH/SOL, with the
 * server time it arrived.
 *
 * Fed by one global event-bus subscriber on `price.tick` (Coinbase trades are
 * the primary publisher; Kraken's ticker publishes only while Coinbase is
 * silent). price.tick already fans out across instances over Redis pub/sub,
 * so every API instance sees the same stream — no shared store needed.
 */

import { subscribeGlobal } from "../events/eventBus";
import type { AppEvent } from "../events/eventTypes";

export const LANDING_SYMBOLS = ["BTC/USD", "ETH/USD", "SOL/USD"] as const;
export type LandingSymbol = (typeof LANDING_SYMBOLS)[number];

export interface LatestTrade {
  price: string;
  receivedAt: number;
}

const latest = new Map<string, LatestTrade>();
const tracked = new Set<string>(LANDING_SYMBOLS);
let started = false;

export function recordTrade(symbol: string, price: string, receivedAt: number = Date.now()): void {
  if (!tracked.has(symbol)) return;
  latest.set(symbol, { price, receivedAt });
}

export function getLatestTrade(symbol: string): LatestTrade | null {
  return latest.get(symbol) ?? null;
}

/** Idempotent — safe to call from every plugin that depends on it. */
export function startLatestTradeTracker(): void {
  if (started) return;
  started = true;
  subscribeGlobal((event: AppEvent) => {
    if (event.type !== "price.tick") return;
    recordTrade(event.data.symbol, event.data.last);
  });
}

/** TEST-ONLY. */
export function __resetLatestTradesForTest(): void {
  latest.clear();
}
