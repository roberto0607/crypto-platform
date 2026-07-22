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
let reconnectDelay = 2000;
const RECONNECT_DELAYS = [2_000, 5_000, 30_000]; // exponential backoff steps
let reconnectAttempt = 0;
let stopped = false;
let flushInterval: ReturnType<typeof setInterval> | null = null;
let watchdogInterval: ReturnType<typeof setInterval> | null = null;
let backfillDone = false;

// ── Watchdog: detect stale connections ──
const WATCHDOG_TIMEOUT_MS = 30_000;
let lastTickAt = 0;
let wsConnected = false;

export function getKrakenWsHealth(): {
    connected: boolean;
    lastTickAt: number;
    secondsSinceLastTick: number;
    status: "connected" | "stale" | "disconnected";
} {
    const secondsSinceLastTick = lastTickAt > 0
        ? Math.round((Date.now() - lastTickAt) / 1000)
        : -1;
    const status = !wsConnected
        ? "disconnected"
        : secondsSinceLastTick > 30
            ? "stale"
            : "connected";
    return { connected: wsConnected, lastTickAt, secondsSinceLastTick, status };
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
    for (const tick of data) {
        const krakenSymbol = tick.symbol;
        const ourSymbol = wsToOurSymbol[krakenSymbol];
        if (!ourSymbol) continue;

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

            // Publish price.tick for trigger engine
            try {
                publish(createEvent("price.tick", {
                    pairId,
                    symbol: ourSymbol,
                    bid,
                    ask,
                    last,
                }));
            } catch {
                // Events must never break the feed
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

    ws = new WebSocket(KRAKEN_WS_URL);

    ws.on("open", async () => {
        console.log("[krakenWs] connected");
        wsConnected = true;
        reconnectAttempt = 0;
        if (!symbolsReady) await refreshSymbols();
        subscribe(ws!);
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

        // Start watchdog to detect stale connections
        if (!watchdogInterval) {
            watchdogInterval = setInterval(() => {
                if (lastTickAt > 0 && Date.now() - lastTickAt > WATCHDOG_TIMEOUT_MS && wsConnected) {
                    console.log("[krakenWs] No ticks for 30s — reconnecting...");
                    wsConnected = false;
                    ws?.close();
                }
            }, 10_000);
        }
    });

    ws.on("message", handleMessage);

    ws.on("close", () => {
        wsConnected = false;
        scheduleReconnect();
    });

    ws.on("error", (err) => {
        console.error("[krakenWs] error", err.message);
        ws?.close();
    });
}

function scheduleReconnect(): void {
    if (stopped) return;
    if (reconnectTimer) return;

    const delay = RECONNECT_DELAYS[Math.min(reconnectAttempt, RECONNECT_DELAYS.length - 1)]!;
    reconnectAttempt++;
    console.log(`[krakenWs] reconnecting in ${delay}ms (attempt ${reconnectAttempt})`);
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
    if (ws) {
        ws.close();
        ws = null;
    }
}
