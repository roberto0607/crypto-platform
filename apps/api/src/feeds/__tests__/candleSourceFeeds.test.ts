import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Both real feeds (krakenWs.ts + coinbaseWs.ts) on fake sockets: each symbol's
// 1m candles are built from exactly one exchange (candleSource.ts) — Kraken
// for symbols Kraken REST syncs, Coinbase for the rest — and the Kraken feed
// seeds the in-progress minute from Kraken REST once, on first connect.
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
        ["BTC/USD", "DOGE/USD"].map((s) => {
            const ws = exchange === "coinbase" ? s.replace("/", "-") : s;
            return { ourSymbol: s, wsSymbol: ws, restSymbol: ws, pairId: `pair-${s}` };
        }),
    ),
}));
const aggregateTick = vi.hoisted(() => vi.fn());
vi.mock("../../market/candleAggregator.js", () => ({ aggregateTick, flushDueCandles: vi.fn(async () => {}) }));
vi.mock("../../market/candleBackfill.js", () => ({ runBackfill: vi.fn(async () => ({})) }));
const seed = vi.hoisted(() => vi.fn(async (_pairs: Array<{ symbol: string; pairId: string }>) => 0));
vi.mock("../../market/formingCandle.js", () => ({ seedOpenCandlesFromKrakenRest: seed }));
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
let tradeIdSeq = 1_000_000;
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
                events: [{ type: "update", trades: [{ trade_id: String(++tradeIdSeq), product_id: p, price: "100", size: "1", side: "BUY", time: new Date().toISOString() }] }],
            }));
        }
        const k = krakenSocket();
        k.emit("message", msg({ channel: "heartbeat" }));
        for (const s of ["BTC/USD", "DOGE/USD"]) {
            k.emit("message", msg({ channel: "book", type: "update", data: [{ symbol: s, bids: [], asks: [] }] }));
            k.emit("message", msg({ channel: "ticker", type: "update", data: [{ symbol: s, last: 101, bid: 100, ask: 102 }] }));
        }
        await vi.advanceTimersByTimeAsync(1_000);
    }
}

const sourcesFor = (pairId: string) => aggregateTick.mock.calls.filter((c) => c[0] === pairId).length;

describe("1m candles: one exchange per symbol", () => {
    beforeEach(async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_700_000_000_000);
        config.candleBackfillOnBoot = false;
        config.krakenWsEnabled = true;
        __resetKrakenWsForTest();
        __resetCoinbaseWsForTest();
        __resetFeedHealthForTest();
        sockets.length = 0;
        aggregateTick.mockClear();
        seed.mockClear();

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

    it("BTC/USD (Kraken REST-synced) aggregates Kraken ticker + trades only; DOGE/USD aggregates Coinbase trades only", async () => {
        await pump(3, ["BTC-USD", "DOGE-USD"]); // Coinbase trades for both + Kraken tickers for both
        for (const s of ["BTC/USD", "DOGE/USD"]) {
            krakenSocket().emit("message", msg({
                channel: "trade", type: "update",
                data: [{ symbol: s, price: 100, qty: 0.5, side: "buy", timestamp: new Date().toISOString() }],
            }));
        }
        await vi.advanceTimersByTimeAsync(0);

        const btc = aggregateTick.mock.calls.filter((c) => c[0] === "pair-BTC/USD").map((c) => c[1]);
        // 3 Kraken tickers (volume 0) + 1 Kraken trade; none of the 3 Coinbase trades.
        expect(btc).toHaveLength(4);
        expect(btc.filter((t) => t.volume === "1")).toEqual([]); // Coinbase fixture size is 1
        expect(btc.filter((t) => t.volume === "0.5")).toHaveLength(1);

        const doge = aggregateTick.mock.calls.filter((c) => c[0] === "pair-DOGE/USD").map((c) => c[1]);
        // 3 Coinbase trades; no Kraken ticker or trade.
        expect(doge).toHaveLength(3);
        expect(doge.every((t) => t.volume === "1")).toBe(true);
        expect(sourcesFor("pair-DOGE/USD")).toBe(3);
    });

    it("seeds the in-progress minute from Kraken REST once, on the first Kraken connect", async () => {
        expect(seed).toHaveBeenCalledTimes(1);
        expect(seed.mock.calls[0]![0]).toEqual(expect.arrayContaining([
            { symbol: "BTC/USD", pairId: "pair-BTC/USD" },
            { symbol: "DOGE/USD", pairId: "pair-DOGE/USD" },
        ]));
        krakenSocket().emit("close", 1006, Buffer.from(""));
        await vi.advanceTimersByTimeAsync(60_000);
        const again = sockets.filter((s) => s.url.includes("kraken")).at(-1);
        if (again && again.readyState === 0) await open(again);
        expect(seed).toHaveBeenCalledTimes(1);
    });
});
