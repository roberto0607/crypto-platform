import WebSocket from "ws";
import { loadActiveSymbols, type ActiveSymbol } from "../market/symbolRegistry.js";
import { aggregateTick } from "../market/candleAggregator.js";
import { logger } from "../observability/logContext.js";
import { coinbaseTradeSide, addSample as addPressureSample } from "../services/pressureAggregator.js";
import { publish } from "../events/eventBus.js";
import { createEvent } from "../events/eventTypes.js";
import { eventsPublishedTotal } from "../metrics.js";
import { config } from "../config.js";
import {
    recordFeedTick,
    recordFeedReconnect,
    recordWatchdogTrip,
    setFeedStale,
    clearFeedStale,
    setReconnectBackoff,
    getLastFeedTickAt,
    type ReconnectCause,
} from "../observability/feedHealth.js";
import { StalenessTracker, ReconnectBackoff, FEED_BACKOFF, type StaleEpisode } from "../market/feedWatchdog.js";

const COINBASE_WS_URL = "wss://advanced-trade-ws.coinbase.com";

/**
 * Coinbase's documented WS limits (live-checked docs.cdp.coinbase.com/
 * coinbase-app/advanced-trade-apis/websocket/websocket-rate-limits) are
 * connection-rate (8/sec/IP) and unauthenticated-message-rate (8/sec/IP) —
 * there is no documented per-connection product_ids ceiling. At the current
 * curated universe size (~75 pairs) a single connection covers everything
 * in one subscribe message, well under both limits. This is still
 * structured around N batched connections (not a bare module-level `ws`)
 * so growing the universe past one batch is a constant change, not a
 * rewrite — see docs/designs/2026-07-22-multi-asset-datafeed-gate1.md
 * section 2.4 for the full rationale.
 */
const COINBASE_WS_BATCH_SIZE = 150;

const SYMBOL_REFRESH_INTERVAL_MS = 5 * 60_000;
const PAIR_CACHE_RETRY_MS = 60_000;

// Coinbase is the primary price.tick source (Gate 1, 2026-07-25 — see
// docs/designs/2026-07-25-price-tick-coinbase-source-gate1.md); krakenWs.ts's
// ticker handler publishes price.tick for a symbol only once Coinbase has
// had no trade on THAT symbol for this long (isCoinbaseStaleFor). Per-symbol,
// so one silent symbol falls back to Kraken while the rest stay on Coinbase.
const COINBASE_STALE_THRESHOLD_MS = 15_000;

// our symbol → pair UUID, keyed off Coinbase product_id (== wsSymbol here).
let productIdToPairId: Record<string, string> = {};
let productIdToOurSymbol: Record<string, string> = {};
let symbolRefreshInterval: ReturnType<typeof setInterval> | null = null;
let pairCacheRetryTimer: ReturnType<typeof setTimeout> | null = null;
let watchdogInterval: ReturnType<typeof setInterval> | null = null;
let stopped = false;
let tradeCount = 0;

// Last live trade (not the subscribe-time snapshot), overall and per our symbol.
let lastTradeAt = 0;
const lastTradeAtBySymbol = new Map<string, number>();

export function getCoinbaseLastTradeAt(): number {
    return lastTradeAt;
}

/** True when Kraken should publish price.tick for `symbol` (Coinbase silent on it). */
export function isCoinbaseStaleFor(symbol: string, now: number = Date.now()): boolean {
    return now - (lastTradeAtBySymbol.get(symbol) ?? 0) > COINBASE_STALE_THRESHOLD_MS;
}

// ── Watchdogs (checked every WATCHDOG_CHECK_MS, per batch socket) ──
//  1. Heartbeat: the `heartbeats` channel (1/s, subscribed on every batch)
//     silent for feedCoinbaseHeartbeatStaleMs → kill. Catches a dead or
//     half-open socket. Also keeps quiet subscriptions open — Coinbase closes
//     channels that send nothing for 60-90s unless heartbeats is subscribed.
//  2. Per-symbol cross-check: no Coinbase trade on a symbol for
//     feedCoinbaseSymbolStaleMs AND Kraken traded that symbol during the
//     silence → kill only if FEED_COINBASE_SYMBOL_KILL_ENABLED, else log
//     feed_watchdog_would_kill. A quiet market is quiet on both exchanges;
//     Coinbase alone going quiet is a dead subscription.
// "Kill" is always terminate() — see krakenWs.ts.
const WATCHDOG_CHECK_MS = 1_000;
const HEARTBEAT_KEY = "heartbeat";

interface Batch {
    index: number;
    productIds: string[];
    ws: WebSocket | null;
    connected: boolean;
    reconnectTimer: ReturnType<typeof setTimeout> | null;
    backoff: ReconnectBackoff;
    heartbeat: StalenessTracker;
    trades: StalenessTracker;
    /** Symbols whose current silence the cross-check has already reported. */
    crossTripped: Set<string>;
}

const batches = new Map<number, Batch>();

/** feed_watchdog / tradr_feed_symbol_stale label for a batch's connection-level checks. */
const connectionKey = (batch: Batch) => (batch.index === 0 ? "_connection" : `_connection_${batch.index}`);

function newBatch(index: number, productIds: string[]): Batch {
    const maxCheckGapMs = 3 * WATCHDOG_CHECK_MS;
    return {
        index,
        productIds,
        ws: null,
        connected: false,
        reconnectTimer: null,
        backoff: new ReconnectBackoff(FEED_BACKOFF),
        heartbeat: new StalenessTracker({ staleMs: config.feedCoinbaseHeartbeatStaleMs, graceMs: config.feedWatchdogGraceMs, maxCheckGapMs }),
        // A symbol with no trade yet gets the full stale window, not the short connect grace.
        trades: new StalenessTracker({ staleMs: config.feedCoinbaseSymbolStaleMs, graceMs: config.feedCoinbaseSymbolStaleMs, maxCheckGapMs }),
        crossTripped: new Set(),
    };
}

function batchSymbols(batch: Batch): string[] {
    const out: string[] = [];
    for (const p of batch.productIds) {
        const s = productIdToOurSymbol[p];
        if (s) out.push(s);
    }
    return out;
}

function chunk<T>(arr: T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
}

async function refreshSymbols(): Promise<ActiveSymbol[]> {
    try {
        const symbols = await loadActiveSymbols("coinbase");
        productIdToPairId = Object.fromEntries(symbols.map((s) => [s.wsSymbol, s.pairId]));
        productIdToOurSymbol = Object.fromEntries(symbols.map((s) => [s.wsSymbol, s.ourSymbol]));
        if (pairCacheRetryTimer) {
            clearTimeout(pairCacheRetryTimer);
            pairCacheRetryTimer = null;
        }
        return symbols;
    } catch (err) {
        logger.error({ err }, "coinbase_symbol_refresh_failed");
        // Retry every 60s until successful — otherwise a DB outage at boot
        // leaves the map empty forever and incoming trades are discarded.
        if (!pairCacheRetryTimer && !stopped) {
            pairCacheRetryTimer = setTimeout(() => {
                pairCacheRetryTimer = null;
                refreshSymbols();
            }, PAIR_CACHE_RETRY_MS);
        }
        return [];
    }
}

function subscribeMessage(type: "subscribe" | "unsubscribe", productIds: string[]) {
    return JSON.stringify({ type, product_ids: productIds, channel: "market_trades" });
}

function handleMessage(batch: Batch, raw: WebSocket.Data): void {
    try {
        const msg = JSON.parse(raw.toString());
        if (msg.channel === "heartbeats") {
            batch.heartbeat.record(HEARTBEAT_KEY, Date.now());
            return;
        }
        if (msg.channel !== "market_trades") return;

        const events: any[] = msg.events;
        if (!events) return;

        for (const event of events) {
            const trades: any[] = event.trades;
            if (!trades) continue;
            // The subscribe-time snapshot replays recent trades: it proves the
            // subscription exists, not that trades are flowing, so it doesn't
            // count as liveness.
            const live = event.type !== "snapshot";

            for (const trade of trades) {
                const productId: string = trade.product_id;
                const ourSymbol = productIdToOurSymbol[productId];
                if (!ourSymbol) continue;

                const pairId = productIdToPairId[productId];
                if (!pairId) continue;

                const price = String(trade.price);
                const volume = String(trade.size);
                const ts = trade.time
                    ? new Date(trade.time).getTime()
                    : Date.now();
                // Coinbase sends "BUY" or "SELL" (taker side) — normalize.
                const side = coinbaseTradeSide(trade);

                aggregateTick(pairId, { price, volume, ts, side });

                // Pressure aggregator hook — runs AFTER aggregateTick so a
                // failure here can never break the existing CVD/candle path.
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

                if (live) {
                    const now = Date.now();
                    lastTradeAt = now;
                    lastTradeAtBySymbol.set(ourSymbol, now);
                    batch.trades.record(ourSymbol, now);
                    batch.crossTripped.delete(ourSymbol);
                    batch.backoff.onHealthy(now);
                }
                recordFeedTick("coinbase_trade", ourSymbol, trade.time ? ts : null);

                // Primary price.tick source (Gate 1, 2026-07-25) — Coinbase's
                // trade prints carry far more volume than Kraken's ticker
                // channel across this pair set. bid/ask are null: market_trades
                // is a trade print, not a quote, and this feed isn't
                // subscribed to a Coinbase order-book/ticker channel. See
                // docs/designs/2026-07-25-price-tick-coinbase-source-gate1.md.
                try {
                    publish(createEvent("price.tick", {
                        pairId,
                        symbol: ourSymbol,
                        bid: null,
                        ask: null,
                        last: price,
                        source: "coinbase",
                    }));
                    eventsPublishedTotal.inc({ type: "price.tick" });
                } catch {
                    // Events must never break the trade feed.
                }

                tradeCount++;
                if (tradeCount % 50 === 0) {
                    console.log(`[coinbaseWs] ${tradeCount} trades ingested (latest: ${ourSymbol} ${price} ${side ?? "?"})`);
                }
            }
        }
    } catch {
        // Ignore unparseable messages (subscription acks, etc.)
    }
}

function connectBatch(batch: Batch): void {
    if (stopped) return;

    const socket = new WebSocket(COINBASE_WS_URL);
    batch.ws = socket;

    socket.on("open", () => {
        console.log(`[coinbaseWs] batch ${batch.index} connected (${batch.productIds.length} products)`);
        const now = Date.now();
        batch.connected = true;
        batch.backoff.onOpen(now);
        batch.heartbeat.reset(now);
        batch.trades.reset(now);
        batch.crossTripped.clear();
        socket.send(subscribeMessage("subscribe", batch.productIds));
        socket.send(JSON.stringify({ type: "subscribe", channel: "heartbeats" }));
    });

    socket.on("message", (raw: WebSocket.Data) => handleMessage(batch, raw));

    socket.on("close", (code: number, reason: Buffer) => {
        dropBatchSocket(batch, socket, "socket_close", null, code, reason.toString());
    });

    socket.on("error", (err) => {
        console.error(`[coinbaseWs] batch ${batch.index} error`, err.message);
        dropBatchSocket(batch, socket, "socket_error", err.message);
    });
}

function runWatchdogs(): void {
    const now = Date.now();
    for (const batch of batches.values()) {
        if (!batch.ws || !batch.connected) continue;
        const conn = connectionKey(batch);

        // 1. Heartbeat.
        let killed = false;
        for (const ep of batch.heartbeat.check([HEARTBEAT_KEY], now)) {
            setFeedStale("coinbase", "heartbeat", conn, true);
            killed = killBatch(batch, "watchdog_heartbeat_stale", conn, ep.silentMs, batch.heartbeat.staleMs,
                config.feedCoinbaseHeartbeatKillEnabled, describe("heartbeat", ep));
        }
        if (killed) continue;
        if (!batch.heartbeat.isStale(HEARTBEAT_KEY)) setFeedStale("coinbase", "heartbeat", conn, false);

        // 2. Per-symbol cross-check against Kraken's trade feed.
        const symbols = batchSymbols(batch);
        batch.trades.check(symbols, now);
        for (const symbol of symbols) {
            if (batch.crossTripped.has(symbol)) continue;
            const since = batch.trades.silentSince(symbol);
            const krakenAt = getLastFeedTickAt("kraken_trade", symbol);
            if (!batch.trades.isStale(symbol) || since === null || krakenAt === null || krakenAt <= since) {
                setFeedStale("coinbase", "trades", symbol, false);
                continue;
            }
            batch.crossTripped.add(symbol);
            setFeedStale("coinbase", "trades", symbol, true);
            const silentMs = now - since;
            const what = batch.trades.ageOf(symbol, now) !== null
                ? `no trades for ${symbol} for ${silentMs}ms`
                : `no trades for ${symbol} within ${silentMs}ms of connect`;
            if (killBatch(batch, "watchdog_cross_check_stale", symbol, silentMs, batch.trades.staleMs,
                config.feedCoinbaseSymbolKillEnabled, `${what} while Kraken traded it ${now - krakenAt}ms ago`)) break;
        }
    }
}

/** e.g. "no heartbeat for 5400ms", "no heartbeat within 11000ms of connect". */
function describe(channel: string, ep: StaleEpisode): string {
    return ep.seenSinceConnect
        ? `no ${channel} for ${ep.silentMs}ms`
        : `no ${channel} within ${ep.silentMs}ms of connect`;
}

/**
 * One stale episode on a batch. With `enabled` the batch's socket is
 * terminated and a reconnect scheduled (returns true); otherwise only
 * feed_watchdog_would_kill is logged.
 */
function killBatch(
    batch: Batch,
    cause: ReconnectCause,
    symbol: string,
    silentMs: number,
    thresholdMs: number,
    enabled: boolean,
    detail: string,
): boolean {
    const action = enabled ? "kill" : "would_kill";
    recordWatchdogTrip("coinbase", cause, symbol, action);
    logger.warn(
        { exchange: "coinbase", batch: batch.index, cause, symbol, silentMs, thresholdMs, attempt: batch.backoff.attempts },
        enabled ? "feed_watchdog_kill" : "feed_watchdog_would_kill",
    );
    if (!enabled || !batch.ws) return false;
    dropBatchSocket(batch, batch.ws, cause, detail);
    return true;
}

/**
 * Stop watching the batch's current socket and terminate it. Listeners are
 * removed first so its late close/error events can never schedule a second
 * reconnect or touch the next socket's state; a no-op error listener stays
 * because terminate() on a CONNECTING socket emits one.
 */
function releaseSocket(batch: Batch): void {
    const socket = batch.ws;
    batch.ws = null;
    batch.connected = false;
    batch.heartbeat.disconnect();
    batch.trades.disconnect();
    batch.crossTripped.clear();
    clearFeedStale("coinbase", [connectionKey(batch), ...batchSymbols(batch)]);
    if (!socket) return;
    socket.removeAllListeners();
    socket.on("error", () => {});
    if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
}

/** Tear down `socket` (if it is still the batch's current one) and schedule exactly one reconnect. */
function dropBatchSocket(
    batch: Batch,
    socket: WebSocket,
    cause: ReconnectCause,
    detail: string | null,
    closeCode?: number,
    closeReason?: string,
): void {
    if (batch.ws !== socket) return;
    releaseSocket(batch);
    scheduleBatchReconnect(batch, cause, detail, closeCode, closeReason);
}

function scheduleBatchReconnect(
    batch: Batch,
    cause: ReconnectCause,
    detail: string | null,
    closeCode?: number,
    closeReason?: string,
): void {
    if (stopped) return;
    if (batch.reconnectTimer) return;
    if (batches.get(batch.index) !== batch) return; // torn down (universe shrank)

    const delay = batch.backoff.nextDelay();
    setReconnectBackoff("coinbase", delay);
    recordFeedReconnect("coinbase", cause, {
        closeCode,
        closeReason,
        detail: detail ? `batch ${batch.index}: ${detail}` : `batch ${batch.index}`,
    });
    logger.info(
        { batch: batch.index, closeCode, closeReason, cause, detail, delay, attempt: batch.backoff.attempts },
        "coinbase_ws_reconnect_scheduled",
    );
    console.log(`[coinbaseWs] batch ${batch.index} reconnecting in ${delay}ms (attempt ${batch.backoff.attempts})`);
    batch.reconnectTimer = setTimeout(() => {
        batch.reconnectTimer = null;
        connectBatch(batch);
    }, delay);
}

function teardownBatch(batch: Batch): void {
    if (batch.reconnectTimer) {
        clearTimeout(batch.reconnectTimer);
        batch.reconnectTimer = null;
    }
    releaseSocket(batch);
}

/**
 * Reconcile the batch connections against the current active symbol set:
 * new batches get a fresh connection, batches whose product list changed
 * get an incremental subscribe/unsubscribe on their existing connection (no
 * reconnect), and batches that no longer exist (universe shrank below a
 * prior batch count) get torn down.
 */
async function reconcileBatches(): Promise<void> {
    const symbols = await refreshSymbols();
    const productIds = symbols.map((s) => s.wsSymbol);
    const chunks = chunk(productIds, COINBASE_WS_BATCH_SIZE);

    for (let i = 0; i < chunks.length; i++) {
        const newProductIds = chunks[i]!;
        const existing = batches.get(i);

        if (!existing) {
            const batch = newBatch(i, newProductIds);
            batches.set(i, batch);
            connectBatch(batch);
            continue;
        }

        const before = new Set(existing.productIds);
        const after = new Set(newProductIds);
        const added = newProductIds.filter((p) => !before.has(p));
        const removed = existing.productIds.filter((p) => !after.has(p));
        existing.productIds = newProductIds;

        if ((added.length > 0 || removed.length > 0) && existing.ws?.readyState === WebSocket.OPEN) {
            if (added.length > 0) existing.ws.send(subscribeMessage("subscribe", added));
            if (removed.length > 0) existing.ws.send(subscribeMessage("unsubscribe", removed));
            logger.info({ batch: i, added, removed }, "coinbase_ws_subscriptions_reconciled");
        }
    }

    // Tear down batches beyond the current chunk count (universe shrank).
    for (const [index, batch] of batches) {
        if (index >= chunks.length) {
            batches.delete(index);
            teardownBatch(batch);
        }
    }
}

export type CoinbaseSymbolHealth = {
    tradeAgeMs: number | null;
    /** quiet = no trade for feedCoinbaseSymbolStaleMs but Kraken is quiet on it too (a normal lull);
     *  stale = the cross-check tripped (Coinbase silent while Kraken trades it). */
    status: "ok" | "quiet" | "stale" | "waiting" | "disconnected";
};

export function getCoinbaseWsHealth(): {
    connected: boolean;
    status: "connected" | "stale" | "disconnected";
    lastTradeAt: number;
    secondsSinceLastTrade: number;
    heartbeatAgeMs: number | null;
    heartbeatKillEnabled: boolean;
    symbolKillEnabled: boolean;
    batches: number;
    symbols: Record<string, CoinbaseSymbolHealth>;
} {
    const now = Date.now();
    let connected = batches.size > 0;
    let anyStale = false;
    let heartbeatAgeMs: number | null = null;
    const symbols: Record<string, CoinbaseSymbolHealth> = {};

    for (const batch of batches.values()) {
        connected &&= batch.connected;
        if (batch.connected) {
            const age = batch.heartbeat.ageOf(HEARTBEAT_KEY, now);
            if (age !== null && (heartbeatAgeMs === null || age > heartbeatAgeMs)) heartbeatAgeMs = age;
            anyStale ||= batch.heartbeat.isStale(HEARTBEAT_KEY) || batch.crossTripped.size > 0;
        }
        for (const symbol of batchSymbols(batch)) {
            const last = lastTradeAtBySymbol.get(symbol);
            const status = !batch.connected
                ? "disconnected"
                : batch.crossTripped.has(symbol)
                    ? "stale"
                    : batch.trades.isStale(symbol)
                        ? "quiet"
                        : batch.trades.ageOf(symbol, now) === null
                            ? "waiting"
                            : "ok";
            symbols[symbol] = { tradeAgeMs: last === undefined ? null : now - last, status };
        }
    }

    return {
        connected,
        status: !connected ? "disconnected" : anyStale ? "stale" : "connected",
        lastTradeAt,
        secondsSinceLastTrade: lastTradeAt > 0 ? Math.round((now - lastTradeAt) / 1000) : -1,
        heartbeatAgeMs,
        heartbeatKillEnabled: config.feedCoinbaseHeartbeatKillEnabled,
        symbolKillEnabled: config.feedCoinbaseSymbolKillEnabled,
        batches: batches.size,
        symbols,
    };
}

export function startCoinbaseFeed(): void {
    stopped = false;
    reconcileBatches().catch((err: unknown) => {
        logger.error({ err }, "coinbase_ws_initial_connect_failed");
    });

    if (!symbolRefreshInterval) {
        symbolRefreshInterval = setInterval(() => {
            reconcileBatches().catch((err: unknown) => {
                logger.error({ err }, "coinbase_ws_symbol_reconcile_failed");
            });
        }, SYMBOL_REFRESH_INTERVAL_MS);
    }

    if (!watchdogInterval) {
        watchdogInterval = setInterval(runWatchdogs, WATCHDOG_CHECK_MS);
    }
}

export function stopCoinbaseFeed(): void {
    stopped = true;
    if (symbolRefreshInterval) {
        clearInterval(symbolRefreshInterval);
        symbolRefreshInterval = null;
    }
    if (watchdogInterval) {
        clearInterval(watchdogInterval);
        watchdogInterval = null;
    }
    if (pairCacheRetryTimer) {
        clearTimeout(pairCacheRetryTimer);
        pairCacheRetryTimer = null;
    }
    for (const batch of batches.values()) teardownBatch(batch);
    batches.clear();
}

/**
 * DEV-ONLY fault injection — see krakenWs.ts's __debugFaultKrakenSocket.
 * A "stall" stops reading every batch socket without closing it; the
 * heartbeat watchdog terminates and reconnects within
 * feedCoinbaseHeartbeatStaleMs (Kraken's per-symbol fallback publish covers
 * price.tick meanwhile).
 */
export function __debugFaultCoinbaseSockets(mode: "close" | "stall" | "resume"): number {
    let n = 0;
    for (const batch of batches.values()) {
        if (!batch.ws) continue;
        if (mode === "close") batch.ws.terminate();
        else if (mode === "stall") batch.ws.pause();
        else batch.ws.resume();
        n++;
    }
    return n;
}

/** TEST-ONLY — reset module state (batches and their trackers are rebuilt from current config on the next start). */
export function __resetCoinbaseWsForTest(): void {
    stopCoinbaseFeed();
    productIdToPairId = {};
    productIdToOurSymbol = {};
    lastTradeAt = 0;
    lastTradeAtBySymbol.clear();
    tradeCount = 0;
}
