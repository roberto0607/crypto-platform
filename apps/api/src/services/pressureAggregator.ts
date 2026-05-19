/**
 * pressureAggregator.ts — Rolling 5-minute buy/sell pressure aggregator.
 *
 * Aggregates aggressor-side trade notional from the existing Coinbase and
 * Kraken trade WS handlers (feeds/coinbaseWs.ts, market/krakenWs.ts) into a
 * per-pair rolling window. The buy/sell pressure ratio is computed on demand.
 *
 * Module-level singleton — no classes, exported start/stop functions, matching
 * the codebase's existing service pattern (see footprintAggregator.ts).
 *
 * Part 1 of 3 for the Market Context Bar feature.
 */

import { logger } from "../observability/logContext.js";

export type TradeSide = "buy" | "sell";

export interface PressureSample {
    ts: number;        // epoch ms
    side: TradeSide;   // aggressor side: 'buy' = market buy, 'sell' = market sell
    notional: number;  // qty * price, in USD
}

export interface PressureSnapshot {
    pair: string;                  // canonical, e.g. 'BTCUSD'
    windowMs: number;              // 300000 (5 min)
    buyNotional: number;           // total $ of aggressor buys in window
    sellNotional: number;          // total $ of aggressor sells in window
    buyPct: number;                // 0-100, integer
    sellPct: number;               // 0-100, integer
    sampleCount: number;
    oldestSampleAt: number | null;
    newestSampleAt: number | null;
    stale: boolean;                // true if no samples in last 60s
    emptyWindow: boolean;          // true if sampleCount === 0
}

// ── Constants ──
const WINDOW_MS = 300_000;          // 5-minute rolling window
const PRUNE_GRACE_MS = 30_000;      // timer prune keeps an extra 30s of slack
const PRUNE_INTERVAL_MS = 60_000;   // background prune cadence
const STALE_MS = 60_000;            // no samples in 60s ⇒ stale
const HARD_CAP = 100_000;           // max samples retained per pair (defense in depth)
const SIGNIFICANT_NOTIONAL = 1_000; // $ threshold that wakes SSE listeners

/** Pairs the aggregator knows about — mirrors the WS feed product maps. */
export const KNOWN_PAIRS = ["BTCUSD", "ETHUSD", "SOLUSD"] as const;

// ── State ──
const buffers = new Map<string, PressureSample[]>();
const lastReceivedAt = new Map<string, number>();
let pruneTimer: ReturnType<typeof setInterval> | null = null;

// SSE listeners — notified when a significant sample lands for a pair. Kept as
// a plain Set (mirrors events/eventBus subscribe/unsubscribe); deliberately
// NOT an event emitter — no new abstraction.
type PressureListener = (canonicalPair: string) => void;
const listeners = new Set<PressureListener>();

// ── Pair normalization ──
/** Canonicalize a pair to slash-free uppercase form, e.g. BTC/USD → BTCUSD. */
export function canonicalPair(pair: string): string {
    return pair.replace(/\//g, "").toUpperCase();
}

/** True if `pair` (in either BTC/USD or BTCUSD form) is a tracked pair. */
export function isKnownPair(pair: string): boolean {
    return (KNOWN_PAIRS as readonly string[]).includes(canonicalPair(pair));
}

// ── Aggressor-side mapping helpers ──
// Centralized here so the critical taker-side mapping is defined ONCE and is
// directly unit-testable. Both exchanges report the TAKER (aggressor) side,
// matching the codebase's existing CVD interpretation in candleAggregator.ts.

/** Coinbase Advanced Trade `market_trades`: `side` is "BUY"/"SELL" (taker). */
export function coinbaseTradeSide(trade: Record<string, unknown>): TradeSide | undefined {
    const raw = typeof trade.side === "string" ? trade.side.toLowerCase() : undefined;
    return raw === "buy" || raw === "sell" ? raw : undefined;
}

/** Kraken WS v2 `trade` channel: `side` is "buy"/"sell" (taker). */
export function krakenTradeSide(trade: Record<string, unknown>): TradeSide | undefined {
    return trade.side === "buy" || trade.side === "sell" ? trade.side : undefined;
}

// ── Ingestion ──
/**
 * Append a trade sample to a pair's rolling buffer. Accepts the pair in either
 * BTC/USD or BTCUSD form. Malformed samples are dropped silently — a bad WS
 * event must never corrupt the buffer.
 */
export function addSample(pair: string, sample: PressureSample): void {
    // Defensive validation. Coinbase/Kraken send price and size as strings;
    // a malformed event can yield NaN notional. Reject anything non-finite or
    // non-positive before it reaches the buffer.
    if (sample.side !== "buy" && sample.side !== "sell") return;
    if (!Number.isFinite(sample.notional) || sample.notional <= 0) return;
    if (!Number.isFinite(sample.ts) || sample.ts <= 0) return;

    const key = canonicalPair(pair);
    let buf = buffers.get(key);
    if (!buf) {
        buf = [];
        buffers.set(key, buf);
    }
    buf.push(sample);
    lastReceivedAt.set(key, Date.now());

    // Hard cap (defense in depth) — drop oldest beyond 100k. The 60s prune
    // timer normally keeps the buffer at a few thousand; this only fires if
    // pruning has somehow failed.
    if (buf.length > HARD_CAP) buf.splice(0, buf.length - HARD_CAP);

    // Wake SSE listeners on significant flow.
    if (sample.notional >= SIGNIFICANT_NOTIONAL && listeners.size > 0) {
        for (const fn of listeners) {
            try {
                fn(key);
            } catch {
                // A misbehaving listener must never break ingestion.
            }
        }
    }
}

// ── Read ──
/** Compute the buy/sell pressure snapshot for a pair (prunes on read). */
export function getSnapshot(pair: string): PressureSnapshot {
    const key = canonicalPair(pair);
    const now = Date.now();
    const cutoff = now - WINDOW_MS;

    // Prune-on-read: drop anything outside the 5-minute window.
    const buf = buffers.get(key);
    const recent = buf ? buf.filter((s) => s.ts >= cutoff) : [];
    if (buf && recent.length !== buf.length) buffers.set(key, recent);

    let buyNotional = 0;
    let sellNotional = 0;
    for (const s of recent) {
        if (s.side === "buy") buyNotional += s.notional;
        else sellNotional += s.notional;
    }
    const total = buyNotional + sellNotional;

    let buyPct: number;
    let sellPct: number;
    let emptyWindow: boolean;
    if (total === 0) {
        emptyWindow = true;
        buyPct = 50;
        sellPct = 50;
    } else {
        emptyWindow = false;
        buyPct = Math.round((buyNotional / total) * 100);
        sellPct = 100 - buyPct; // derived ⇒ buyPct + sellPct is always exactly 100
    }

    const oldestSampleAt = recent.length > 0 ? recent[0]!.ts : null;
    const newestSampleAt = recent.length > 0 ? recent[recent.length - 1]!.ts : null;
    const stale = newestSampleAt === null || now - newestSampleAt > STALE_MS;

    return {
        pair: key,
        windowMs: WINDOW_MS,
        buyNotional,
        sellNotional,
        buyPct,
        sellPct,
        sampleCount: recent.length,
        oldestSampleAt,
        newestSampleAt,
        stale,
        emptyWindow,
    };
}

/** Internal state for the debug endpoint. */
export function getStatus(): {
    pairs: string[];
    totalSamples: number;
    perPair: Array<{ pair: string; sampleCount: number; lastReceivedAt: number | null }>;
} {
    let totalSamples = 0;
    const perPair: Array<{ pair: string; sampleCount: number; lastReceivedAt: number | null }> = [];
    for (const [pair, buf] of buffers) {
        totalSamples += buf.length;
        perPair.push({
            pair,
            sampleCount: buf.length,
            lastReceivedAt: lastReceivedAt.get(pair) ?? null,
        });
    }
    return { pairs: [...buffers.keys()], totalSamples, perPair };
}

// ── SSE listener registry ──
export function subscribePressure(fn: PressureListener): void {
    listeners.add(fn);
}

export function unsubscribePressure(fn: PressureListener): void {
    listeners.delete(fn);
}

// ── Lifecycle ──
export function startPressureAggregator(): void {
    if (pruneTimer) return;
    pruneTimer = setInterval(() => {
        const cutoff = Date.now() - WINDOW_MS - PRUNE_GRACE_MS;
        for (const [pair, buf] of buffers) {
            const recent = buf.filter((s) => s.ts >= cutoff);
            if (recent.length !== buf.length) buffers.set(pair, recent);
        }
    }, PRUNE_INTERVAL_MS);
    logger.info(`Pressure aggregator started for pairs: [${KNOWN_PAIRS.join(", ")}]`);
}

export function stopPressureAggregator(): void {
    if (pruneTimer) {
        clearInterval(pruneTimer);
        pruneTimer = null;
    }
    buffers.clear();
    lastReceivedAt.clear();
    listeners.clear();
}
