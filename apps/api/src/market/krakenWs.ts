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
let symbolToPairId: Record<string, string> = {};
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
let reconnectDelay = 1000;
const MAX_RECONNECT_DELAY = 30_000;
let stopped = false;
let flushInterval: ReturnType<typeof setInterval> | null = null;
let backfillDone = false;

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
}

async function handleTickerMessage(data: any[]): Promise<void> {
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

        aggregateTick(pairId, { price, volume, ts });
    }
}

async function handleMessage(raw: WebSocket.Data): Promise<void> {
    try {
        const msg = JSON.parse(raw.toString());
        if (msg.type !== "update") return;

        if (msg.channel === "ticker") {
            await handleTickerMessage(msg.data);
        } else if (msg.channel === "trade") {
            handleTradeMessage(msg.data);
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
        reconnectDelay = 1000;
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
    });

    ws.on("message", handleMessage);

    ws.on("close", () => {
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

    console.log(`[krakenWs] reconnecting in ${reconnectDelay}ms`);
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
        reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
    }, reconnectDelay);
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
    if (flushInterval) {
        clearInterval(flushInterval);
        flushInterval = null;
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
