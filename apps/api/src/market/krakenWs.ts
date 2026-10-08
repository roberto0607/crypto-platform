import WebSocket from "ws";
import { setSnapshot } from "./snapshotStore";
import { publish } from "../events/eventBus";
import { createEvent } from "../events/eventTypes";
import { loadActiveSymbols, type ActiveSymbol } from "./symbolRegistry.js";
import { pool } from "../db/pool.js";
import { config } from "../config.js";
import { aggregateTick, flushDueCandles } from "./candleAggregator.js";
import { runBackfill } from "./candleBackfill.js";
import { logger } from "../observability/logContext.js";
import {
    computeOrderFlowFeatures,
    bookSnapshots,
    orderFlowCache,
    type BookLevel,
} from "./orderFlowFeatures.js";
import { krakenTradeSide, addSample as addPressureSample } from "../services/pressureAggregator.js";
import { eventsPublishedTotal } from "../metrics.js";
import { isCoinbaseStaleFor } from "../feeds/coinbaseWs.js";
import { recordKrakenReconnectAttempt, isKrakenReconnectBudgetExceeded, KRAKEN_BACKOFF } from "./krakenReconnectTracker.js";
import {
    recordFeedTick,
    recordFeedReconnect,
    recordWatchdogTrip,
    setFeedStale,
    clearFeedStale,
    setReconnectBackoff,
    type ReconnectCause,
} from "../observability/feedHealth.js";
import { StalenessTracker, ReconnectBackoff, type StaleEpisode } from "./feedWatchdog.js";

// Debounce: track last DB write time per pair to avoid write storms
const lastSyncTime = new Map<string, number>();

const KRAKEN_WS_URL = "wss://ws.kraken.com/v2";

// DB-driven active symbol set (trading_pairs × exchange_symbol_map) —
// replaces the old hardcoded SYMBOL_MAP literal. Populated by
// refreshSymbols() on connect and re-polled every SYMBOL_REFRESH_INTERVAL_MS
// so new/delisted pairs are picked up without a reconnect.
let activeSymbols: ActiveSymbol[] = [];
let wsToOurSymbol: Record<string, string> = {};

// our symbol → pair UUID — exported for krakenBookRoutes.ts.
export let symbolToPairId: Record<string, string> = {};
let symbolsReady = false;

const SYMBOL_REFRESH_INTERVAL_MS = 5 * 60_000;
let symbolRefreshInterval: ReturnType<typeof setInterval> | null = null;

async function refreshSymbols(): Promise<ActiveSymbol[]> {
    try {
        const symbols = await loadActiveSymbols("kraken");
        activeSymbols = symbols;
        wsToOurSymbol = Object.fromEntries(symbols.map((s) => [s.wsSymbol, s.ourSymbol]));
        symbolToPairId = Object.fromEntries(symbols.map((s) => [s.ourSymbol, s.pairId]));
        symbolsReady = true;
        return symbols;
    } catch {
        // Will retry on next connect / next refresh tick
        return activeSymbols;
    }
}

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let stopped = false;
let flushInterval: ReturnType<typeof setInterval> | null = null;
let watchdogInterval: ReturnType<typeof setInterval> | null = null;
let backfillDone = false;

// KRAKEN_BACKOFF + the combined 10-min reconnect budget are shared with
// footprintAggregator.ts's socket (krakenReconnectTracker.ts).
let backoff = new ReconnectBackoff(KRAKEN_BACKOFF);

// ── Watchdogs (checked every WATCHDOG_CHECK_MS) ──
//  1. Safety net: no ticker message on ANY symbol for 30s → kill. Ticker only
//     fires on trades (per-symbol gaps of 15s are normal), hence whole-socket.
//  2. Heartbeat: Kraken's v2 heartbeat (~1/s) silent for
//     feedKrakenHeartbeatStaleMs → kill. Catches a dead or half-open socket.
//  3. Per-symbol book: no book message for one symbol for
//     feedKrakenBookStaleMs → kill only if FEED_WATCHDOG_KILL_ENABLED, else
//     log feed_watchdog_would_kill. Catches one symbol's subscription dying
//     while the rest of the socket (and so 1 and 2) looks healthy.
// "Kill" is always terminate(): close() waits for a closing handshake a
// half-open socket never answers (the ws lib's 30s close timeout).
const WATCHDOG_TIMEOUT_MS = 30_000;
const WATCHDOG_CHECK_MS = 1_000;
const HEARTBEAT_KEY = "heartbeat";
const CONNECTION_SYMBOL = "_connection";
let lastTickAt = 0;
// When the current socket opened. The safety net measures from the later of
// this and lastTickAt, so a fresh socket isn't killed for the previous one's
// silence before its first ticker arrives.
let socketOpenedAt = 0;
let wsConnected = false;

const trackerOpts = () => ({ graceMs: config.feedWatchdogGraceMs, maxCheckGapMs: 3 * WATCHDOG_CHECK_MS });
let bookTracker = new StalenessTracker({ staleMs: config.feedKrakenBookStaleMs, ...trackerOpts() });
let heartbeatTracker = new StalenessTracker({ staleMs: config.feedKrakenHeartbeatStaleMs, ...trackerOpts() });

export type KrakenSymbolHealth = {
    bookAgeMs: number | null;
    status: "ok" | "stale" | "waiting";
};

export function getKrakenWsHealth(): {
    connected: boolean;
    lastTickAt: number;
    secondsSinceLastTick: number;
    status: "connected" | "stale" | "disconnected";
    heartbeatAgeMs: number | null;
    bookKillEnabled: boolean;
    symbols: Record<string, KrakenSymbolHealth>;
} {
    const now = Date.now();
    const secondsSinceLastTick = lastTickAt > 0
        ? Math.round((now - lastTickAt) / 1000)
        : -1;

    const symbols: Record<string, KrakenSymbolHealth> = {};
    let anyBookStale = false;
    for (const s of activeSymbols) {
        const bookAgeMs = wsConnected ? bookTracker.ageOf(s.ourSymbol, now) : null;
        const stale = wsConnected && bookTracker.isStale(s.ourSymbol);
        anyBookStale ||= stale;
        symbols[s.ourSymbol] = { bookAgeMs, status: stale ? "stale" : bookAgeMs === null ? "waiting" : "ok" };
    }

    const status = !wsConnected
        ? "disconnected"
        : secondsSinceLastTick > 30 || anyBookStale || heartbeatTracker.isStale(HEARTBEAT_KEY)
            ? "stale"
            : "connected";
    return {
        connected: wsConnected,
        lastTickAt,
        secondsSinceLastTick,
        status,
        heartbeatAgeMs: wsConnected ? heartbeatTracker.ageOf(HEARTBEAT_KEY, now) : null,
        bookKillEnabled: config.feedWatchdogKillEnabled,
        symbols,
    };
}

function sendSubscription(socket: WebSocket, method: "subscribe" | "unsubscribe", symbols: string[]): void {
    if (symbols.length === 0) return;

    socket.send(JSON.stringify({ method, params: { channel: "ticker", symbol: symbols } }));
    socket.send(JSON.stringify({ method, params: { channel: "trade", symbol: symbols, snapshot: false } }));
    socket.send(JSON.stringify({ method, params: { channel: "book", depth: 25, symbol: symbols, snapshot: true } }));
}

function subscribe(socket: WebSocket): void {
    sendSubscription(socket, "subscribe", activeSymbols.map((s) => s.wsSymbol));
}

/**
 * Re-fetch the active symbol set and diff it against what this connection is
 * currently subscribed to, sending incremental subscribe/unsubscribe
 * messages for just the delta — no reconnect. Runs on a
 * SYMBOL_REFRESH_INTERVAL_MS timer so new pairs (backfill script or the
 * periodic symbol-refresh job) and delistings are picked up live.
 */
async function reconcileSubscriptions(): Promise<void> {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    const before = new Set(activeSymbols.map((s) => s.wsSymbol));
    const after = await refreshSymbols();
    const afterSet = new Set(after.map((s) => s.wsSymbol));

    const added = after.filter((s) => !before.has(s.wsSymbol)).map((s) => s.wsSymbol);
    const removed = [...before].filter((wsSymbol) => !afterSet.has(wsSymbol));

    if (added.length === 0 && removed.length === 0) return;

    sendSubscription(ws, "subscribe", added);
    sendSubscription(ws, "unsubscribe", removed);
    logger.info({ added, removed }, "kraken_ws_subscriptions_reconciled");
}

async function handleTickerMessage(data: any[]): Promise<void> {
    lastTickAt = Date.now();
    backoff.onHealthy(lastTickAt);
    for (const tick of data) {
        const krakenSymbol = tick.symbol;
        const ourSymbol = wsToOurSymbol[krakenSymbol];
        if (!ourSymbol) continue;
        recordFeedTick("kraken_ticker", ourSymbol);

        const last = String(tick.last);
        const bid = tick.bid != null ? String(tick.bid) : null;
        const ask = tick.ask != null ? String(tick.ask) : null;

        await setSnapshot(ourSymbol, {
            bid,
            ask,
            last,
            ts: new Date().toISOString(),
        });

        const pairId = symbolToPairId[ourSymbol];
        if (pairId) {
            // Feed ticker into candle aggregator as safety net.
            // Volume "0" = synthetic tick — ensures candles form even with no trades.
            aggregateTick(pairId, { price: last, volume: "0", ts: Date.now() });

            // Fallback price.tick publish — Coinbase is the primary source
            // (coinbaseWs.ts's trade handler) as of Gate 1. Only publish here
            // if Coinbase is stale on THIS symbol, to avoid the two sources
            // ticking concurrently (recon found a persistent small
            // Kraken/Coinbase price divergence that would otherwise flicker
            // the hero price). Per-symbol: a global "any Coinbase trade"
            // clock let one busy symbol mask another symbol's dead feed.
            if (isCoinbaseStaleFor(ourSymbol)) {
                try {
                    publish(createEvent("price.tick", {
                        pairId,
                        symbol: ourSymbol,
                        bid,
                        ask,
                        last,
                        source: "kraken",
                    }));
                    eventsPublishedTotal.inc({ type: "price.tick" });
                } catch {
                    // Events must never break the feed
                }
            }

            // Sync last_price to DB (debounced)
            const now = Date.now();
            const lastSync = lastSyncTime.get(pairId) ?? 0;
            if (now - lastSync >= config.lastPriceSyncIntervalMs) {
                lastSyncTime.set(pairId, now);
                pool.query(
                    `UPDATE trading_pairs SET last_price = $1 WHERE id = $2`,
                    [last, pairId],
                ).catch((err) => {
                    logger.error({ err, pairId }, "last_price_sync_failed");
                });
            }
        }
    }
}

function handleTradeMessage(data: any[]): void {
    for (const trade of data) {
        const krakenSymbol = trade.symbol;
        const ourSymbol = wsToOurSymbol[krakenSymbol];
        if (!ourSymbol) continue;

        const pairId = symbolToPairId[ourSymbol];
        if (!pairId) continue;

        const price = String(trade.price);
        const volume = String(trade.qty);
        const ts = trade.timestamp
            ? new Date(trade.timestamp).getTime()
            : Date.now();
        // Kraken WS v2 trade channel includes 'side' ("buy" or "sell", taker).
        const side = krakenTradeSide(trade);
        recordFeedTick("kraken_trade", ourSymbol, trade.timestamp ? ts : null);

        aggregateTick(pairId, { price, volume, ts, side });

        // Pressure aggregator hook — runs AFTER aggregateTick so a failure
        // here can never break the existing CVD/candle path.
        if (side) {
            try {
                addPressureSample(ourSymbol, {
                    ts,
                    side,
                    notional: Number(price) * Number(volume),
                });
            } catch {
                // Pressure ingestion must never disrupt the trade feed.
            }
        }
    }
}

const BOOK_DEPTH = 25;

function handleBookSnapshot(pairId: string, rawBids: any[], rawAsks: any[]): void {
    const bids: BookLevel[] = rawBids.map((b: any) => ({
        price: parseFloat(b.price),
        qty: parseFloat(b.qty),
    }));
    const asks: BookLevel[] = rawAsks.map((a: any) => ({
        price: parseFloat(a.price),
        qty: parseFloat(a.qty),
    }));
    bookSnapshots.set(pairId, { bids, asks, ts: Date.now() });
    const features = computeOrderFlowFeatures(bids, asks);
    orderFlowCache.set(pairId, { ...features, ts: Date.now() });
}

function applyBookUpdate(pairId: string, rawBids: any[], rawAsks: any[]): void {
    const existing = bookSnapshots.get(pairId);
    if (!existing) return; // No snapshot yet, skip incremental

    // Apply bid updates
    const bidMap = new Map(existing.bids.map((b) => [b.price, b.qty]));
    for (const b of rawBids) {
        const price = parseFloat(b.price);
        const qty = parseFloat(b.qty);
        if (qty === 0) bidMap.delete(price);
        else bidMap.set(price, qty);
    }
    // Sort bids descending, truncate to depth
    const bids = Array.from(bidMap.entries())
        .map(([price, qty]) => ({ price, qty }))
        .sort((a, b) => b.price - a.price)
        .slice(0, BOOK_DEPTH);

    // Apply ask updates
    const askMap = new Map(existing.asks.map((a) => [a.price, a.qty]));
    for (const a of rawAsks) {
        const price = parseFloat(a.price);
        const qty = parseFloat(a.qty);
        if (qty === 0) askMap.delete(price);
        else askMap.set(price, qty);
    }
    // Sort asks ascending, truncate to depth
    const asks = Array.from(askMap.entries())
        .map(([price, qty]) => ({ price, qty }))
        .sort((a, b) => a.price - b.price)
        .slice(0, BOOK_DEPTH);

    bookSnapshots.set(pairId, { bids, asks, ts: Date.now() });
    const features = computeOrderFlowFeatures(bids, asks);
    orderFlowCache.set(pairId, { ...features, ts: Date.now() });
}

function handleBookMessage(data: any[], type: string): void {
    for (const entry of data) {
        const krakenSymbol = entry.symbol;
        if (!krakenSymbol) continue;

        const ourSymbol = wsToOurSymbol[krakenSymbol];
        if (!ourSymbol) continue;

        const pairId = symbolToPairId[ourSymbol];
        if (!pairId) continue;
        recordFeedTick("kraken_book", ourSymbol, entry.timestamp ? new Date(entry.timestamp).getTime() : null);
        const now = Date.now();
        bookTracker.record(ourSymbol, now);
        backoff.onHealthy(now);

        const rawBids: any[] = entry.bids || [];
        const rawAsks: any[] = entry.asks || [];

        if (type === "snapshot") {
            handleBookSnapshot(pairId, rawBids, rawAsks);
        } else {
            applyBookUpdate(pairId, rawBids, rawAsks);
        }
    }
}

async function handleMessage(raw: WebSocket.Data): Promise<void> {
    try {
        const msg = JSON.parse(raw.toString());
        if (msg.channel === "heartbeat") {
            heartbeatTracker.record(HEARTBEAT_KEY, Date.now());
            return;
        }
        // Accept both "update" and "snapshot" types for book channel
        if (msg.type !== "update" && msg.type !== "snapshot") return;

        if (msg.channel === "ticker") {
            await handleTickerMessage(msg.data);
        } else if (msg.channel === "trade") {
            handleTradeMessage(msg.data);
        } else if (msg.channel === "book") {
            handleBookMessage(msg.data, msg.type);
        }
    } catch {
        // Ignore unparseable messages (heartbeats, etc.)
    }
}

function connect(): void {
    if (stopped) return;

    const socket = new WebSocket(KRAKEN_WS_URL);
    ws = socket;

    socket.on("open", async () => {
        console.log("[krakenWs] connected");
        const now = Date.now();
        wsConnected = true;
        socketOpenedAt = now;
        backoff.onOpen(now);
        bookTracker.reset(now);
        heartbeatTracker.reset(now);
        if (!symbolsReady) await refreshSymbols();
        if (ws !== socket) return; // killed while symbols loaded
        subscribe(socket);
        if (!flushInterval) {
            flushInterval = setInterval(() => {
                flushDueCandles().catch((err: unknown) => {
                    logger.error({ err }, "candle_flush_failed");
                });
            }, 5_000);
        }

        // Live symbol reconciliation — picks up new pairs (backfill script,
        // periodic symbol-refresh job) and delistings without a reconnect.
        if (!symbolRefreshInterval) {
            symbolRefreshInterval = setInterval(() => {
                reconcileSubscriptions().catch((err: unknown) => {
                    logger.error({ err }, "kraken_ws_symbol_reconcile_failed");
                });
            }, SYMBOL_REFRESH_INTERVAL_MS);
        }

        // One-time candle backfill on first connect (fire-and-forget)
        if (config.candleBackfillOnBoot && !backfillDone) {
            backfillDone = true;
            runBackfill()
                .then((r) => logger.info(r, "candle_backfill_complete"))
                .catch((e) => logger.error({ err: e }, "candle_backfill_failed"));
        }

        if (!watchdogInterval) {
            watchdogInterval = setInterval(runWatchdogs, WATCHDOG_CHECK_MS);
        }
    });

    socket.on("message", handleMessage);

    socket.on("close", (code: number, reason: Buffer) => {
        dropSocket(socket, "socket_close", null, code, reason.toString());
    });

    socket.on("error", (err) => {
        console.error("[krakenWs] error", err.message);
        dropSocket(socket, "socket_error", err.message);
    });
}

function runWatchdogs(): void {
    if (!ws || !wsConnected) return;
    const now = Date.now();

    // 1. 30s whole-socket ticker safety net — always kills.
    const silentSince = Math.max(lastTickAt, socketOpenedAt);
    if (now - silentSince > WATCHDOG_TIMEOUT_MS) {
        const silentMs = now - silentSince;
        console.log("[krakenWs] No ticks for 30s — reconnecting...");
        killSocket("watchdog_stale", CONNECTION_SYMBOL, silentMs, WATCHDOG_TIMEOUT_MS, true, `no ticker for ${silentMs}ms`);
        return;
    }

    // 2. Heartbeat.
    for (const ep of heartbeatTracker.check([HEARTBEAT_KEY], now)) {
        setFeedStale("kraken", "heartbeat", CONNECTION_SYMBOL, true);
        if (killSocket("watchdog_heartbeat_stale", CONNECTION_SYMBOL, ep.silentMs, heartbeatTracker.staleMs,
            config.feedKrakenHeartbeatKillEnabled, describe("heartbeat", ep))) return;
    }
    if (!heartbeatTracker.isStale(HEARTBEAT_KEY)) setFeedStale("kraken", "heartbeat", CONNECTION_SYMBOL, false);

    // 3. Per-symbol book.
    const symbols = activeSymbols.map((s) => s.ourSymbol);
    for (const ep of bookTracker.check(symbols, now)) {
        setFeedStale("kraken", "book", ep.key, true);
        if (killSocket("watchdog_book_stale", ep.key, ep.silentMs, bookTracker.staleMs,
            config.feedWatchdogKillEnabled, describe("book", ep))) return;
    }
    for (const symbol of symbols) {
        if (!bookTracker.isStale(symbol)) setFeedStale("kraken", "book", symbol, false);
    }
}

/** e.g. "no book for SOL/USD for 10400ms", "no heartbeat within 11000ms of connect". */
function describe(channel: string, ep: StaleEpisode): string {
    const what = ep.key === HEARTBEAT_KEY ? channel : `${channel} for ${ep.key}`;
    return ep.seenSinceConnect
        ? `no ${what} for ${ep.silentMs}ms`
        : `no ${what} within ${ep.silentMs}ms of connect`;
}

/**
 * One stale episode. With `enabled` the socket is terminated and a reconnect
 * scheduled (returns true); otherwise only feed_watchdog_would_kill is logged.
 */
function killSocket(
    cause: ReconnectCause,
    symbol: string,
    silentMs: number,
    thresholdMs: number,
    enabled: boolean,
    detail: string,
): boolean {
    const action = enabled ? "kill" : "would_kill";
    recordWatchdogTrip("kraken", cause, symbol, action);
    logger.warn(
        { exchange: "kraken", cause, symbol, silentMs, thresholdMs, attempt: backoff.attempts },
        enabled ? "feed_watchdog_kill" : "feed_watchdog_would_kill",
    );
    if (!enabled || !ws) return false;
    dropSocket(ws, cause, detail);
    return true;
}

/**
 * Tear down `socket` for good and schedule exactly one reconnect. Listeners
 * are removed first so the old socket's late close/error events can never
 * schedule a second reconnect or touch the new socket's state; a no-op error
 * listener stays because terminate() on a CONNECTING socket emits one.
 */
function dropSocket(
    socket: WebSocket,
    cause: ReconnectCause,
    detail: string | null,
    closeCode?: number,
    closeReason?: string,
): void {
    if (ws !== socket) return;
    ws = null;
    wsConnected = false;
    bookTracker.disconnect();
    heartbeatTracker.disconnect();
    clearFeedStale("kraken");
    socket.removeAllListeners();
    socket.on("error", () => {});
    if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
    scheduleReconnect(cause, detail, closeCode, closeReason);
}

function scheduleReconnect(cause: ReconnectCause, detail: string | null, closeCode?: number, closeReason?: string): void {
    if (stopped) return;
    if (reconnectTimer) return;

    const combinedReconnectCount10m = recordKrakenReconnectAttempt();
    const budgetExceeded = isKrakenReconnectBudgetExceeded(combinedReconnectCount10m);
    const delay = backoff.nextDelay({ budgetExceeded });
    setReconnectBackoff("kraken", delay);
    recordFeedReconnect("kraken", cause, { closeCode, closeReason, detail });
    logger.info(
        { closeCode, closeReason, cause, detail, delay, attempt: backoff.attempts, combinedReconnectCount10m, budgetExceeded },
        "kraken_ws_reconnect_scheduled",
    );
    console.log(`[krakenWs] reconnecting in ${delay}ms (attempt ${backoff.attempts})`);
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
    }, delay);
}

export function startKrakenFeed(): void {
    if (!config.krakenWsEnabled) {
        logger.info("Kraken WS feed disabled via KRAKEN_WS_ENABLED=false");
        return;
    }
    stopped = false;
    connect();
}

export function stopKrakenFeed(): void {
    stopped = true;
    wsConnected = false;
    if (flushInterval) {
        clearInterval(flushInterval);
        flushInterval = null;
    }
    if (watchdogInterval) {
        clearInterval(watchdogInterval);
        watchdogInterval = null;
    }
    if (symbolRefreshInterval) {
        clearInterval(symbolRefreshInterval);
        symbolRefreshInterval = null;
    }
    flushDueCandles().catch((err: unknown) => {
        logger.error({ err }, "shutdown_flush_due_candles_failed");
    });
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    bookTracker.disconnect();
    heartbeatTracker.disconnect();
    clearFeedStale("kraken");
    if (ws) {
        ws.close();
        ws = null;
    }
}

/**
 * DEV-ONLY fault injection for the feed-staleness repro (routes/v1/
 * v1DebugFeedFault.ts, never registered in production). "close" terminates
 * the socket (exercises the reconnect path); "stall" stops reading from it
 * without closing (a half-open/silent stall — the heartbeat watchdog
 * notices within feedKrakenHeartbeatStaleMs, the 30s ticker net otherwise);
 * "resume" undoes a stall.
 */
export function __debugFaultKrakenSocket(mode: "close" | "stall" | "resume"): boolean {
    if (!ws) return false;
    if (mode === "close") ws.terminate();
    else if (mode === "stall") ws.pause();
    else ws.resume();
    return true;
}

/** TEST-ONLY — rebuild the trackers from current config and reset module state. */
export function __resetKrakenWsForTest(): void {
    stopKrakenFeed();
    lastTickAt = 0;
    socketOpenedAt = 0;
    activeSymbols = [];
    wsToOurSymbol = {};
    symbolToPairId = {};
    symbolsReady = false;
    bookTracker = new StalenessTracker({ staleMs: config.feedKrakenBookStaleMs, ...trackerOpts() });
    heartbeatTracker = new StalenessTracker({ staleMs: config.feedKrakenHeartbeatStaleMs, ...trackerOpts() });
    backoff = new ReconnectBackoff(KRAKEN_BACKOFF);
}
