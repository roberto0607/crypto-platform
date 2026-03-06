import WebSocket from "ws";
import { setSnapshot } from "./snapshotStore";
import { publish } from "../events/eventBus";
import { createEvent } from "../events/eventTypes";
import { listActivePairs } from "../trading/pairRepo";
import { pool } from "../db/pool.js";
import { config } from "../config.js";
import { aggregateTick, flushDueCandles } from "./candleAggregator.js";
import { logger } from "../observability/logContext.js";

// Debounce: track last DB write time per pair to avoid write storms
const lastSyncTime = new Map<string, number>();

const KRAKEN_WS_URL = "wss://ws.kraken.com/v2";

// Kraken uses XBT for Bitcoin
const SYMBOL_MAP: Record<string, string> = {
    "BTC/USD": "XBT/USD",
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

function subscribe(socket: WebSocket): void {
    const msg = {
        method: "subscribe",
        params: {
            channel: "ticker",
            symbol: Object.values(SYMBOL_MAP),
        },
    };
    socket.send(JSON.stringify(msg));
}

async function handleMessage(raw: WebSocket.Data): Promise<void> {
    try {
        const msg = JSON.parse(raw.toString());

        if (msg.channel !== "ticker" || msg.type !== "update") return;

        for (const tick of msg.data) {
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

            // Publish price.tick for trigger engine
            const pairId = symbolToPairId[ourSymbol];
            if (pairId) {
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

                // Feed tick to candle aggregator
                aggregateTick(pairId, {
                    price: last,
                    volume: "0",
                    ts: Date.now(),
                });
            }
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
