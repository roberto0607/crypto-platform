import WebSocket from "ws";
import { setSnapshot } from "./snapshotStore";
import { publish } from "../events/eventBus";
import { createEvent } from "../events/eventTypes";
import { listActivePairs } from "../trading/pairRepo";
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

// Debounce: track last DB write time per pair to avoid write storms
const lastSyncTime = new Map<string, number>();

const KRAKEN_WS_URL = "wss://ws.kraken.com/v2";

// Kraken WS v2 uses BTC (not XBT) — symbols match ours directly
export const SYMBOL_MAP: Record<string, string> = {
    "BTC/USD": "BTC/USD",
    "ETH/USD": "ETH/USD",
    "SOL/USD": "SOL/USD",
};

const REVERSE_MAP: Record<string, string> = {};
for (const [ours, kraken] of Object.entries(SYMBOL_MAP)) {
    REVERSE_MAP[kraken] = ours;
}

// Lazy cache: our symbol → pair UUID (populated on first connect)
export let symbolToPairId: Record<string, string> = {};
let pairCacheReady = false;

async function loadPairCache(): Promise<void> {
    try {
        const pairs = await listActivePairs();
        const map: Record<string, string> = {};
        for (const p of pairs) {
            map[p.symbol] = p.id;
        }
        symbolToPairId = map;
        pairCacheReady = true;
    } catch {
        // Will retry on next connect
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

function subscribe(socket: WebSocket): void {
    const symbols = Object.values(SYMBOL_MAP);

    // Ticker: bid/ask/last for snapshots and price.tick events
    socket.send(JSON.stringify({
        method: "subscribe",
        params: { channel: "ticker", symbol: symbols },
    }));

    // Trade: individual trades with real volume for candle aggregation
    socket.send(JSON.stringify({
        method: "subscribe",
        params: { channel: "trade", symbol: symbols, snapshot: false },
    }));

    // Book: 25-level depth for order flow analysis
    socket.send(JSON.stringify({
        method: "subscribe",
        params: { channel: "book", depth: 25, symbol: symbols, snapshot: true },
    }));
}

async function handleTickerMessage(data: any[]): Promise<void> {
    lastTickAt = Date.now();
    for (const tick of data) {
        const krakenSymbol = tick.symbol;
        const ourSymbol = REVERSE_MAP[krakenSymbol];
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
        const ourSymbol = REVERSE_MAP[krakenSymbol];
        if (!ourSymbol) continue;

        const pairId = symbolToPairId[ourSymbol];
        if (!pairId) continue;

        const price = String(trade.price);
        const volume = String(trade.qty);
        const ts = trade.timestamp
            ? new Date(trade.timestamp).getTime()
            : Date.now();
        // Kraken WS v2 trade channel includes 'side' ("buy" or "sell")
        const side = trade.side === "buy" || trade.side === "sell" ? trade.side : undefined;

        aggregateTick(pairId, { price, volume, ts, side });
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

        const ourSymbol = REVERSE_MAP[krakenSymbol];
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
        if (!pairCacheReady) await loadPairCache();
        subscribe(ws!);
        if (!flushInterval) {
            flushInterval = setInterval(() => {
                flushDueCandles().catch((err: unknown) => {
                    logger.error({ err }, "candle_flush_failed");
                });
            }, 5_000);
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
    flushDueCandles().catch(() => {});
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    if (ws) {
        ws.close();
        ws = null;
    }
}
