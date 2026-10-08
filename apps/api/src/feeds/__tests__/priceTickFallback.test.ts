import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Both real feeds (krakenWs.ts + coinbaseWs.ts) on fake sockets: Kraken's
// ticker handler must fall back to publishing price.tick per symbol, only for
// symbols Coinbase has gone silent on.
const sockets = vi.hoisted(() => [] as any[]);
vi.mock("ws", async () => {
    const { EventEmitter } = await import("node:events");
    class FakeWebSocket extends EventEmitter {
        static CONNECTING = 0;
        static OPEN = 1;
        static CLOSING = 2;
        static CLOSED = 3;
        readyState = 0;
        terminate = vi.fn(() => { this.readyState = 3; });
        close = vi.fn(() => { this.readyState = 2; });
        pause = vi.fn();
        resume = vi.fn();
        constructor(public url: string) {
            super();
            sockets.push(this);
        }
        send() {}
    }
    return { default: FakeWebSocket };
});

vi.mock("../../market/symbolRegistry.js", () => ({
    loadActiveSymbols: vi.fn(async (exchange: string) =>
        ["BTC/USD", "SOL/USD"].map((s) => {
            const ws = exchange === "coinbase" ? s.replace("/", "-") : s;
            return { ourSymbol: s, wsSymbol: ws, restSymbol: ws, pairId: `pair-${s}` };
        }),
    ),
}));
vi.mock("../../market/candleAggregator.js", () => ({ aggregateTick: vi.fn(), flushDueCandles: vi.fn(async () => {}) }));
vi.mock("../../market/candleBackfill.js", () => ({ runBackfill: vi.fn(async () => ({})) }));
vi.mock("../../market/snapshotStore", () => ({ setSnapshot: vi.fn(async () => {}) }));
vi.mock("../../services/pressureAggregator.js", () => ({
    coinbaseTradeSide: () => "buy",
    krakenTradeSide: () => "buy",
    addSample: vi.fn(),
}));
const publish = vi.hoisted(() => vi.fn());
vi.mock("../../events/eventBus", () => ({ publish }));
vi.mock("../../events/eventBus.js", () => ({ publish }));
vi.mock("../../db/pool.js", () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));
vi.mock("../../observability/logContext.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { config } from "../../config";
import { startKrakenFeed, __resetKrakenWsForTest } from "../../market/krakenWs";
import { startCoinbaseFeed, __resetCoinbaseWsForTest } from "../coinbaseWs";
import { __resetFeedHealthForTest } from "../../observability/feedHealth";

const saved = { backfill: config.candleBackfillOnBoot, enabled: config.krakenWsEnabled };
const msg = (o: unknown) => Buffer.from(JSON.stringify(o));
const krakenSocket = () => sockets.find((s) => s.url.includes("kraken"));
const coinbaseSocket = () => sockets.find((s) => s.url.includes("coinbase"));

async function open(socket: any) {
    socket.readyState = 1;
    socket.emit("open");
    await vi.advanceTimersByTimeAsync(0);
}

/** One second of traffic: Coinbase trades for `coinbase`, Kraken heartbeat/book/ticker for both symbols. */
async function pump(seconds: number, coinbase: string[]) {
    for (let i = 0; i < seconds; i++) {
        const cb = coinbaseSocket();
        cb.emit("message", msg({ channel: "heartbeats", events: [{}] }));
        for (const p of coinbase) {
            cb.emit("message", msg({
                channel: "market_trades",
                events: [{ type: "update", trades: [{ product_id: p, price: "100", size: "1", side: "BUY", time: new Date().toISOString() }] }],
            }));
        }
        const k = krakenSocket();
        k.emit("message", msg({ channel: "heartbeat" }));
        for (const s of ["BTC/USD", "SOL/USD"]) {
            k.emit("message", msg({ channel: "book", type: "update", data: [{ symbol: s, bids: [], asks: [] }] }));
            k.emit("message", msg({ channel: "ticker", type: "update", data: [{ symbol: s, last: 101, bid: 100, ask: 102 }] }));
        }
        await vi.advanceTimersByTimeAsync(1_000);
    }
}

const priceTicks = (source: string) =>
    publish.mock.calls
        .map((c) => c[0])
        .filter((e) => e.type === "price.tick" && e.data?.source === source)
        .map((e) => e.data.symbol);

describe("price.tick Kraken fallback is per-symbol", () => {
    beforeEach(async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_700_000_000_000);
        config.candleBackfillOnBoot = false;
        config.krakenWsEnabled = true;
        __resetKrakenWsForTest();
        __resetCoinbaseWsForTest();
        __resetFeedHealthForTest();
        sockets.length = 0;

        startCoinbaseFeed();
        startKrakenFeed();
        await vi.advanceTimersByTimeAsync(0);
        await open(coinbaseSocket());
        await open(krakenSocket());
    });

    afterEach(() => {
        __resetKrakenWsForTest();
        __resetCoinbaseWsForTest();
        config.candleBackfillOnBoot = saved.backfill;
        config.krakenWsEnabled = saved.enabled;
        vi.useRealTimers();
    });

    it("SOL silent on Coinbase while BTC trades → Kraken publishes price.tick for SOL only", async () => {
        await pump(5, ["BTC-USD", "SOL-USD"]);
        expect(priceTicks("kraken")).toEqual([]); // Coinbase live on both → Kraken stays quiet
        expect(new Set(priceTicks("coinbase"))).toEqual(new Set(["BTC/USD", "SOL/USD"]));

        publish.mockClear();
        await pump(20, ["BTC-USD"]); // SOL goes silent on Coinbase; BTC keeps trading

        const kraken = priceTicks("kraken");
        expect(kraken.length).toBeGreaterThan(0);
        expect(new Set(kraken)).toEqual(new Set(["SOL/USD"]));
        expect(new Set(priceTicks("coinbase"))).toEqual(new Set(["BTC/USD"]));

        // SOL resumes on Coinbase → Kraken stops publishing it.
        await pump(1, ["BTC-USD", "SOL-USD"]);
        publish.mockClear();
        await pump(3, ["BTC-USD", "SOL-USD"]);
        expect(priceTicks("kraken")).toEqual([]);
    });
});
