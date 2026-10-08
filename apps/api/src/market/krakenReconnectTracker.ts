import { FEED_BACKOFF } from "./feedWatchdog.js";

// Combined reconnect-attempt counter across BOTH independent Kraken WS
// connections (krakenWs.ts + footprintAggregator.ts). Added as a diagnostic
// for the theory in docs/followups.md (2026-08-13, Kraken WS instability)
// that two sockets racing to reconnect off the same IP after a shared network
// blip could push toward Cloudflare's documented ~150 reconnects/10min per-IP
// ban threshold — and now also enforced as a shared budget: past
// KRAKEN_RECONNECT_BUDGET_10M attempts in the window, both sockets wait the
// backoff cap instead of their exponential step.
const WINDOW_MS = 10 * 60_000;
export const KRAKEN_RECONNECT_BUDGET_10M = 20;

// Backoff shape for both Kraken sockets — the shared feed shape (feedWatchdog.ts).
export const KRAKEN_BACKOFF = FEED_BACKOFF;
const attempts: number[] = [];

/** Record one attempt; returns the combined count over the last 10 minutes. */
export function recordKrakenReconnectAttempt(now: number = Date.now()): number {
    attempts.push(now);
    while (attempts.length > 0 && attempts[0]! < now - WINDOW_MS) {
        attempts.shift();
    }
    return attempts.length;
}

export function isKrakenReconnectBudgetExceeded(count10m: number): boolean {
    return count10m > KRAKEN_RECONNECT_BUDGET_10M;
}

/** TEST-ONLY */
export function __resetKrakenReconnectTrackerForTest(): void {
    attempts.length = 0;
}
