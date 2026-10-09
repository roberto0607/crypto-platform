/**
 * feedHealth.ts — diagnostic-only instrumentation for the market-data path
 * (exchange WS → ingest → snapshot store / eventBus → SSE). Added for the
 * 2026-10-01 "PRICE DELAYED" + bad-market-fill investigation; it observes,
 * it never changes trading or feed behavior.
 *
 * Tracks, all in-process:
 *   - last-tick receive time per feed per symbol (+ exchange event time when
 *     the feed carries one, so receive lag vs the exchange is visible)
 *   - WS reconnects per exchange, with the cause and close code/reason
 *   - event-loop lag (perf_hooks.monitorEventLoopDelay), rolled every 10s
 *
 *   - feed watchdog trips (kill / would_kill), per-symbol stale state and
 *     the current reconnect backoff (market/feedWatchdog.ts via krakenWs.ts
 *     and coinbaseWs.ts)
 *
 * One read feeds back into behavior: coinbaseWs.ts's per-symbol cross-check
 * asks getLastFeedTickAt("kraken_trade", symbol) whether Kraken is still
 * trading a symbol Coinbase has gone silent on (this module is the one place
 * both feeds already report to, so neither feed has to import the other).
 *
 * Exposed both as Prometheus metrics (default registry, scraped via
 * /metrics) and as a JSON snapshot for GET /v1/market/feed-health, which
 * backs the browser's ?debug=1 overlay.
 */
import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";
import client from "prom-client";

export type FeedName = "kraken_ticker" | "kraken_trade" | "kraken_book" | "coinbase_trade";
export type FeedExchange = "kraken" | "coinbase";
export type ReconnectCause =
    | "watchdog_stale" // the 30s whole-socket ticker safety net
    | "watchdog_heartbeat_stale"
    | "watchdog_book_stale"
    | "watchdog_cross_check_stale" // Coinbase silent on a symbol while Kraken trades it
    | "book_checksum_mass_mismatch" // many symbols' Kraken book checksums failed at once
    | "book_resync_timeout" // a resubscribed Kraken book never sent its fresh snapshot
    | "socket_error"
    | "socket_close";
export type WatchdogAction = "kill" | "would_kill";

interface TickStat {
    lastReceivedAt: number;
    /** Exchange-reported event time of the last tick (ms), when the feed has one. */
    lastExchangeTs: number | null;
    count: number;
}

interface ReconnectRecord {
    at: number;
    cause: ReconnectCause;
    closeCode: number | null;
    closeReason: string | null;
    detail: string | null;
}

const RECENT_RECONNECTS = 10;
const STALE_SYMBOL_MS = 30_000;
const EVENT_LOOP_WINDOW_MS = 10_000;
const EVENT_LOOP_RESOLUTION_MS = 20;

// feed → symbol → stat
const ticks = new Map<FeedName, Map<string, TickStat>>();
const reconnects = new Map<FeedExchange, { total: number; recent: ReconnectRecord[] }>();

// ── Recording ──

export function recordFeedTick(feed: FeedName, symbol: string, exchangeTs: number | null = null): void {
    let bySymbol = ticks.get(feed);
    if (!bySymbol) {
        bySymbol = new Map();
        ticks.set(feed, bySymbol);
    }
    const stat = bySymbol.get(symbol);
    const now = Date.now();
    const ts = exchangeTs !== null && Number.isFinite(exchangeTs) ? exchangeTs : null;
    if (stat) {
        stat.lastReceivedAt = now;
        stat.lastExchangeTs = ts;
        stat.count++;
    } else {
        bySymbol.set(symbol, { lastReceivedAt: now, lastExchangeTs: ts, count: 1 });
    }
}

export function recordFeedReconnect(
    exchange: FeedExchange,
    cause: ReconnectCause,
    opts: { closeCode?: number | null; closeReason?: string | null; detail?: string | null } = {},
): void {
    let entry = reconnects.get(exchange);
    if (!entry) {
        entry = { total: 0, recent: [] };
        reconnects.set(exchange, entry);
    }
    entry.total++;
    entry.recent.push({
        at: Date.now(),
        cause,
        closeCode: opts.closeCode ?? null,
        closeReason: opts.closeReason || null,
        detail: opts.detail ?? null,
    });
    if (entry.recent.length > RECENT_RECONNECTS) entry.recent.shift();
    feedReconnectsTotal.inc({ exchange, cause });
}

// ── Feed watchdog ──

// "exchange|channel|symbol" → stale (1) / fresh (0)
const staleState = new Map<string, { exchange: FeedExchange; channel: string; symbol: string; stale: boolean }>();
const backoffSeconds = new Map<FeedExchange, number>();

export function recordWatchdogTrip(
    exchange: FeedExchange,
    cause: ReconnectCause,
    symbol: string,
    action: WatchdogAction,
): void {
    feedWatchdogTripsTotal.inc({ exchange, cause, symbol, action });
}

export function setFeedStale(exchange: FeedExchange, channel: string, symbol: string, stale: boolean): void {
    staleState.set(`${exchange}|${channel}|${symbol}`, { exchange, channel, symbol, stale });
}

/**
 * Drop stale-state series for an exchange (on disconnect, before the next
 * socket's first check) — all of them, or only those for `symbols` when one
 * of several sockets (a Coinbase batch) drops.
 */
export function clearFeedStale(exchange: FeedExchange, symbols?: readonly string[]): void {
    const only = symbols ? new Set(symbols) : null;
    for (const [key, v] of staleState) {
        if (v.exchange === exchange && (!only || only.has(v.symbol))) staleState.delete(key);
    }
}

export function setReconnectBackoff(exchange: FeedExchange, delayMs: number): void {
    backoffSeconds.set(exchange, delayMs / 1000);
}

// ── Kraken book checksum (krakenWs.ts + market/krakenBook.ts) ──

export type BookChecksumResult = "ok" | "mismatch" | "unverified_no_precision" | "unverified_no_checksum";
export type BookResyncOutcome = "requested" | "recovered";

// symbols whose book is currently dropped pending a fresh snapshot (enforce mode)
const invalidBooks = new Set<string>();

export function recordBookChecksum(symbol: string, result: BookChecksumResult): void {
    bookChecksumTotal.inc({ symbol, result });
}

export function recordBookResync(symbol: string, outcome: BookResyncOutcome): void {
    bookResyncsTotal.inc({ symbol, outcome });
}

export function setBookInvalid(symbol: string, invalid: boolean): void {
    if (invalid) invalidBooks.add(symbol);
    else invalidBooks.delete(symbol);
}

export function clearBookInvalid(): void {
    invalidBooks.clear();
}

// ── Event-loop lag ──

let loopHistogram: IntervalHistogram | null = null;
let loopRollTimer: ReturnType<typeof setInterval> | null = null;
let loopWindow: { p50Ms: number; p99Ms: number; maxMs: number; windowEndedAt: number } | null = null;
let loopMaxSinceBootMs = 0;

/** Idempotent. Called from server.ts at boot. */
export function startEventLoopMonitor(): void {
    if (loopHistogram) return;
    loopHistogram = monitorEventLoopDelay({ resolution: EVENT_LOOP_RESOLUTION_MS });
    loopHistogram.enable();
    loopRollTimer = setInterval(rollEventLoopWindow, EVENT_LOOP_WINDOW_MS);
    loopRollTimer.unref();
}

export function stopEventLoopMonitor(): void {
    if (loopRollTimer) clearInterval(loopRollTimer);
    loopRollTimer = null;
    loopHistogram?.disable();
    loopHistogram = null;
}

function rollEventLoopWindow(): void {
    if (!loopHistogram) return;
    // Histogram values are nanoseconds and include the sampling interval
    // itself (an idle loop reads ≈ resolution), so report only the excess.
    const toMs = (ns: number) => Math.max(0, Math.round((ns / 1e6 - EVENT_LOOP_RESOLUTION_MS) * 10) / 10);
    const maxMs = toMs(loopHistogram.max);
    loopWindow = {
        p50Ms: toMs(loopHistogram.percentile(50)),
        p99Ms: toMs(loopHistogram.percentile(99)),
        maxMs,
        windowEndedAt: Date.now(),
    };
    if (maxMs > loopMaxSinceBootMs) loopMaxSinceBootMs = maxMs;
    loopHistogram.reset();
}

// ── Snapshot (JSON) ──

export interface FeedSymbolHealth {
    ageMs: number;
    /** receivedAt − exchange event time of the last tick; null if the feed has no event time. */
    exchangeLagMs: number | null;
    count: number;
}

export interface FeedSummary {
    symbols: number;
    newestAgeMs: number | null;
    /** Symbols whose last tick is older than 30s — a permanently-stale symbol shows up here
     *  even while the feed as a whole (and its global watchdog) looks healthy. */
    staleSymbols: Array<{ symbol: string; ageMs: number }>;
}

/** Receive time of the last message on `feed` for `symbol`, or null if none yet. */
export function getLastFeedTickAt(feed: FeedName, symbol: string): number | null {
    return ticks.get(feed)?.get(symbol)?.lastReceivedAt ?? null;
}

export function getSymbolFeedHealth(symbol: string): Record<string, FeedSymbolHealth | null> {
    const now = Date.now();
    const out: Record<string, FeedSymbolHealth | null> = {};
    for (const feed of ALL_FEEDS) {
        const stat = ticks.get(feed)?.get(symbol);
        out[feed] = stat
            ? {
                ageMs: now - stat.lastReceivedAt,
                exchangeLagMs: stat.lastExchangeTs !== null ? stat.lastReceivedAt - stat.lastExchangeTs : null,
                count: stat.count,
            }
            : null;
    }
    return out;
}

export function getFeedHealthSnapshot() {
    const now = Date.now();
    const feeds: Record<string, FeedSummary> = {};
    for (const feed of ALL_FEEDS) {
        const bySymbol = ticks.get(feed);
        let newest: number | null = null;
        const staleSymbols: FeedSummary["staleSymbols"] = [];
        for (const [symbol, stat] of bySymbol ?? []) {
            const age = now - stat.lastReceivedAt;
            if (newest === null || age < newest) newest = age;
            if (age > STALE_SYMBOL_MS) staleSymbols.push({ symbol, ageMs: age });
        }
        staleSymbols.sort((a, b) => b.ageMs - a.ageMs);
        feeds[feed] = { symbols: bySymbol?.size ?? 0, newestAgeMs: newest, staleSymbols };
    }

    const reconnectOut: Record<string, { total: number; recent: ReconnectRecord[] }> = {};
    for (const exchange of ["kraken", "coinbase"] as const) {
        const entry = reconnects.get(exchange);
        reconnectOut[exchange] = { total: entry?.total ?? 0, recent: [...(entry?.recent ?? [])] };
    }

    return {
        serverNow: now,
        feeds,
        reconnects: reconnectOut,
        eventLoop: {
            monitoring: loopHistogram !== null,
            lastWindow: loopWindow,
            maxSinceBootMs: loopMaxSinceBootMs,
        },
    };
}

const ALL_FEEDS: FeedName[] = ["kraken_ticker", "kraken_trade", "kraken_book", "coinbase_trade"];

/** TEST-ONLY — reset all recorded state. */
export function __resetFeedHealthForTest(): void {
    ticks.clear();
    reconnects.clear();
    staleState.clear();
    backoffSeconds.clear();
    feedWatchdogTripsTotal.reset();
    loopWindow = null;
    loopMaxSinceBootMs = 0;
    feedReconnectsTotal.reset();
    bookChecksumTotal.reset();
    bookResyncsTotal.reset();
    invalidBooks.clear();
}

/** TEST-ONLY — force an event-loop window roll. */
export function __rollEventLoopWindowForTest(): void {
    rollEventLoopWindow();
}

// ── Prometheus ──

const feedReconnectsTotal = new client.Counter({
    name: "tradr_feed_ws_reconnects_total",
    help: "Exchange WS reconnects scheduled, by exchange and cause",
    labelNames: ["exchange", "cause"] as const,
});

const feedWatchdogTripsTotal = new client.Counter({
    name: "tradr_feed_watchdog_trips_total",
    help: "Feed watchdog stale episodes, by exchange, cause, symbol (\"_connection\"[_N] for heartbeat/safety net) and action (kill, or would_kill while the kill is disabled)",
    labelNames: ["exchange", "cause", "symbol", "action"] as const,
});

new client.Gauge({
    name: "tradr_feed_symbol_stale",
    help: "1 while the feed watchdog considers a symbol's channel stale on the current connection, else 0",
    labelNames: ["exchange", "channel", "symbol"] as const,
    collect() {
        this.reset();
        for (const v of staleState.values()) {
            this.set({ exchange: v.exchange, channel: v.channel, symbol: v.symbol }, v.stale ? 1 : 0);
        }
    },
});

new client.Gauge({
    name: "tradr_feed_reconnect_backoff_seconds",
    help: "Delay chosen for the most recently scheduled reconnect, per exchange",
    labelNames: ["exchange"] as const,
    collect() {
        this.reset();
        for (const [exchange, s] of backoffSeconds) this.set({ exchange }, s);
    },
});

new client.Gauge({
    name: "tradr_feed_last_tick_age_seconds",
    help: "Seconds since the last message per feed per symbol",
    labelNames: ["feed", "symbol"] as const,
    collect() {
        this.reset();
        const now = Date.now();
        for (const [feed, bySymbol] of ticks) {
            for (const [symbol, stat] of bySymbol) {
                this.set({ feed, symbol }, (now - stat.lastReceivedAt) / 1000);
            }
        }
    },
});

new client.Gauge({
    name: "tradr_event_loop_lag_ms",
    help: "Event-loop lag beyond the 20ms sampling interval, over the last 10s window (monitorEventLoopDelay)",
    labelNames: ["stat"] as const,
    collect() {
        if (!loopWindow) return;
        this.set({ stat: "p50" }, loopWindow.p50Ms);
        this.set({ stat: "p99" }, loopWindow.p99Ms);
        this.set({ stat: "max" }, loopWindow.maxMs);
    },
});

const bookChecksumTotal = new client.Counter({
    name: "tradr_kraken_book_checksum_total",
    help: "Kraken book messages checked against Kraken's CRC32, by symbol and result (ok, mismatch, unverified_no_precision, unverified_no_checksum)",
    labelNames: ["symbol", "result"] as const,
});

const bookResyncsTotal = new client.Counter({
    name: "tradr_kraken_book_resyncs_total",
    help: "Per-symbol Kraken book resubscribes after a checksum mismatch (requested), and fresh snapshots that ended one (recovered)",
    labelNames: ["symbol", "outcome"] as const,
});

new client.Gauge({
    name: "tradr_kraken_book_invalid",
    help: "1 while a symbol's Kraken book is dropped after a checksum mismatch, pending a fresh snapshot (KRAKEN_BOOK_CHECKSUM_ENFORCE only)",
    labelNames: ["symbol"] as const,
    collect() {
        this.reset();
        for (const symbol of invalidBooks) this.set({ symbol }, 1);
    },
});
