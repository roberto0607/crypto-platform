import WebSocket from "ws";
import { listActivePairs } from "../trading/pairRepo";
import { aggregateTick } from "../market/candleAggregator.js";
import { logger } from "../observability/logContext.js";

const COINBASE_WS_URL = "wss://advanced-trade-ws.coinbase.com";

// Coinbase product IDs → our symbols
const PRODUCT_MAP: Record<string, string> = {
    "BTC-USD": "BTC/USD",
    "ETH-USD": "ETH/USD",
    "SOL-USD": "SOL/USD",
};

// Our symbol → pair UUID (populated on connect)
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
let tradeCount = 0;

function subscribe(socket: WebSocket): void {
    socket.send(JSON.stringify({
        type: "subscribe",
        product_ids: Object.keys(PRODUCT_MAP),
        channel: "market_trades",
    }));
}

function handleMessage(raw: WebSocket.Data): void {
    try {
        const msg = JSON.parse(raw.toString());
        if (msg.channel !== "market_trades") return;

        const events: any[] = msg.events;
        if (!events) return;

        for (const event of events) {
            const trades: any[] = event.trades;
            if (!trades) continue;

            for (const trade of trades) {
                const productId: string = trade.product_id;
                const ourSymbol = PRODUCT_MAP[productId];
                if (!ourSymbol) continue;

                const pairId = symbolToPairId[ourSymbol];
                if (!pairId) continue;

                const price = String(trade.price);
                const volume = String(trade.size);
                const ts = trade.time
                    ? new Date(trade.time).getTime()
                    : Date.now();
                // Coinbase sends "BUY" or "SELL" — normalize to lowercase
                const rawSide = typeof trade.side === "string" ? trade.side.toLowerCase() : undefined;
                const side = rawSide === "buy" || rawSide === "sell" ? rawSide : undefined;

                aggregateTick(pairId, { price, volume, ts, side });

                tradeCount++;
                if (tradeCount % 50 === 0) {
                    console.log(`[coinbaseWs] ${tradeCount} trades ingested (latest: ${ourSymbol} ${price} ${side ?? "?"})`);
                }
            }
        }
    } catch {
        // Ignore unparseable messages (heartbeats, subscriptions, etc.)
    }
}

function connect(): void {
    if (stopped) return;

    ws = new WebSocket(COINBASE_WS_URL);

    ws.on("open", async () => {
        console.log("[coinbaseWs] connected");
        reconnectDelay = 1000;
        if (!pairCacheReady) await loadPairCache();
        subscribe(ws!);
    });

    ws.on("message", handleMessage);

    ws.on("close", () => {
        scheduleReconnect();
    });

    ws.on("error", (err) => {
        console.error("[coinbaseWs] error", err.message);
        ws?.close();
    });
}

function scheduleReconnect(): void {
    if (stopped) return;
    if (reconnectTimer) return;

    console.log(`[coinbaseWs] reconnecting in ${reconnectDelay}ms`);
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
        reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
    }, reconnectDelay);
}

export function startCoinbaseFeed(): void {
    stopped = false;
    connect();
}

export function stopCoinbaseFeed(): void {
    stopped = true;
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    if (ws) {
        ws.close();
        ws = null;
    }
}
