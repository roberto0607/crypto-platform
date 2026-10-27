/**
 * The mark an ISOLATED position is judged by: the mid of the Kraken book
 * (priceCollar.getCollarReference: ≤ MARKET_COLLAR_MAX_BOOK_AGE_MS old, not
 * crossed) while krakenWs reports the symbol ok. Anything else is "paused":
 * no mark, never the ticker or trading_pairs.last_price.
 *
 * One definition, so the liquidation engine, the mark.price events it
 * publishes and GET /positions' ISOLATED fields (mark, P&L, health) can't
 * disagree. Design: docs/designs/2026-10-13-leverage-design.md §2.3.
 */
import Decimal from "decimal.js";
import { getKrakenWsHealth } from "../market/krakenWs";
import { bookSnapshots } from "../market/orderFlowFeatures";
import { getCollarReference, type CollarReference } from "./priceCollar";
import { markOf } from "./liquidation";

export type FeedStatus = "ok" | "stale" | "waiting" | "disconnected";

/** krakenWs's view of a symbol's book feed. */
export function krakenFeedStatus(symbol: string): FeedStatus {
    const health = getKrakenWsHealth();
    if (!health.connected) return "disconnected";
    return health.symbols[symbol]?.status ?? "waiting";
}

export type LiquidationMark =
    | { ok: true; mark: Decimal; ref: CollarReference; feed: "ok" }
    | { ok: false; feed: FeedStatus; bookAgeMs: number | null };

let feedStatusOverride: ((symbol: string) => FeedStatus) | null = null;

/** Tests: stand in for krakenWs (no live feed in tests). null restores it. */
export function __setFeedStatusForTest(fn: ((symbol: string) => FeedStatus) | null): void {
    feedStatusOverride = fn;
}

export function liquidationMark(
    pairId: string,
    symbol: string,
    now: number = Date.now(),
    feedStatus: (symbol: string) => FeedStatus = feedStatusOverride ?? krakenFeedStatus,
): LiquidationMark {
    const feed = feedStatus(symbol);
    const ref = feed === "ok" ? getCollarReference(pairId, now) : null;
    if (!ref) {
        const book = bookSnapshots.get(pairId);
        return { ok: false, feed, bookAgeMs: book ? now - book.ts : null };
    }
    return { ok: true, mark: markOf(ref), ref, feed: "ok" };
}
