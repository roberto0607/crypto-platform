import WebSocket from "ws";
import { setSnapshot } from "./snapshotStore";
import { publish } from "../events/eventBus";
import { createEvent } from "../events/eventTypes";
import { listActivePairs } from "../trading/pairRepo";

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
    stopped = false;
    connect();
}

export function stopKrakenFeed(): void {
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
