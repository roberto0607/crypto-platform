import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// coinbaseWs.ts (fake socket) → the REAL candle aggregator, whose flush is
// captured at the SQL boundary. Coinbase sends every batch newest-first —
// the subscribe-time snapshot (100 trades/product) and multi-trade updates.
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
    loadActiveSymbols: vi.fn(async () => [{ ourSymbol: "BTC/USD", wsSymbol: "BTC-USD", restSymbol: "BTC-USD", pairId: "pair-btc" }]),
}));
const pressure = vi.hoisted(() => ({ samples: [] as Array<{ ts: number; notional: number }> }));
vi.mock("../../services/pressureAggregator.js", () => ({
    coinbaseTradeSide: (t: any) => (t.side === "BUY" ? "buy" : "sell"),
    addSample: (_pair: string, s: { ts: number; notional: number }) => pressure.samples.push(s),
}));
const publish = vi.hoisted(() => vi.fn());
vi.mock("../../events/eventBus.js", () => ({ publish }));
const query = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => ({ rows: [] })));
vi.mock("../../db/pool.js", () => ({ pool: { query } }));
vi.mock("../../market/marketSymbols.js", () => ({ getMarketDataPairIds: async () => new Set(["pair-btc"]) }));
vi.mock("../../observability/logContext.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { startCoinbaseFeed, __resetCoinbaseWsForTest } from "../coinbaseWs";
import { aggregateTick, flushDueCandles, getOpenCandle, __resetCandleAggregatorForTest } from "../../market/candleAggregator";
import { __resetFeedHealthForTest } from "../../observability/feedHealth";

// Minute M starts at T0.
const T0 = Date.UTC(2026, 9, 8, 14, 0, 0);
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();

type T = { id: number; price: number; size?: number; sec: number };
/** A market_trades message whose trades arrive newest-first, as Coinbase sends them. */
const batch = (type: "update" | "snapshot", trades: T[]) =>
    Buffer.from(JSON.stringify({
        channel: "market_trades",
        events: [{
            type,
            trades: [...trades].sort((a, b) => b.id - a.id).map((t) => ({
                trade_id: String(t.id), product_id: "BTC-USD", price: String(t.price), size: String(t.size ?? 1), side: "BUY", time: at(t.sec),
            })),
        }],
    }));

const current = () => sockets[sockets.length - 1];
const priceTicks = () => publish.mock.calls.map((c) => c[0]).filter((e) => e.type === "price.tick").map((e) => Number(e.data.last));
const storedCandles = () =>
    query.mock.calls
        .filter((c) => String(c[0]).includes("INSERT INTO candles"))
        .map((c) => { const p = c[1] as unknown[]; return { ts: p[1], open: Number(p[2]), high: Number(p[3]), low: Number(p[4]), close: Number(p[5]), volume: Number(p[6]) }; });

async function open() {
    const s = current();
    s.readyState = 1;
    s.emit("open");
    await vi.advanceTimersByTimeAsync(0);
}
async function reconnect() {
    current().emit("close", 1006, Buffer.from(""));
    await vi.advanceTimersByTimeAsync(1_200); // backoff attempt 1 ≈ 1s (±20%)
    await open();
}
function send(type: "update" | "snapshot", trades: T[]) {
    current().emit("message", batch(type, trades));
}

describe("Coinbase trade batches: ordering, snapshot replay, stored candles", () => {
    beforeEach(async () => {
        vi.useFakeTimers();
        vi.setSystemTime(T0 + 1_000);
        __resetCoinbaseWsForTest();
        __resetCandleAggregatorForTest();
        __resetFeedHealthForTest();
        publish.mockClear();
        query.mockClear();
        pressure.samples.length = 0;
        sockets.length = 0;
        startCoinbaseFeed();
        await vi.advanceTimersByTimeAsync(0);
        await open();
    });

    afterEach(() => {
        __resetCoinbaseWsForTest();
        vi.useRealTimers();
    });

    it("a live update arriving newest-first is processed oldest→newest: price.tick and candle close end on the newest trade", () => {
        send("update", [{ id: 101, price: 100, sec: 1 }, { id: 102, price: 101, sec: 1 }, { id: 103, price: 102, sec: 1 }]);
        expect(priceTicks()).toEqual([100, 101, 102]);
        expect(getOpenCandle("pair-btc")).toMatchObject({ open: "100", close: "102", high: "102", low: "100", volume: "3" });
        expect(pressure.samples.map((s) => s.notional)).toEqual([100, 101, 102]);
    });

    it("cold start: the subscribe-time snapshot is skipped entirely (it predates this process)", () => {
        send("snapshot", [{ id: 90, price: 95, sec: -50 }, { id: 91, price: 96, sec: -40 }, { id: 99, price: 97, sec: -1 }]);
        expect(priceTicks()).toEqual([]);
        expect(getOpenCandle("pair-btc")).toBeUndefined();
        expect(pressure.samples).toEqual([]);

        send("update", [{ id: 100, price: 98, sec: 1 }]);
        expect(priceTicks()).toEqual([98]);
    });

    it("reconnect: only trades missed while disconnected are replayed, oldest→newest, counted once", async () => {
        send("update", [{ id: 101, price: 100, size: 1, sec: 1 }, { id: 102, price: 101, size: 2, sec: 2 }]);
        send("update", [{ id: 103, price: 102, size: 3, sec: 3 }]);
        publish.mockClear();

        await reconnect();
        // Snapshot overlaps what was already ingested live (101–103) plus the gap (104–105).
        send("snapshot", [
            { id: 101, price: 100, size: 1, sec: 1 }, { id: 102, price: 101, size: 2, sec: 2 }, { id: 103, price: 102, size: 3, sec: 3 },
            { id: 104, price: 104, size: 4, sec: 4 }, { id: 105, price: 103, size: 5, sec: 5 },
        ]);

        // One price.tick: the newest gap trade (not the oldest snapshot trade, not a burst).
        expect(priceTicks()).toEqual([103]);
        // Volume / CVD / pressure: every trade exactly once (1+2+3 live, 4+5 gap).
        expect(getOpenCandle("pair-btc")).toMatchObject({ open: "100", high: "104", low: "100", close: "103", volume: "15", buyVolume: "15", tickCount: 5 });
        expect(pressure.samples.map((s) => s.ts)).toEqual([1, 2, 3, 4, 5].map((s) => T0 + s * 1000));
    });

    it("price.tick after a reconnect is never older than the last live price: an all-old snapshot publishes nothing", async () => {
        send("update", [{ id: 110, price: 200, sec: 10 }]);
        publish.mockClear();
        await reconnect();
        send("snapshot", [{ id: 105, price: 150, sec: 5 }, { id: 108, price: 160, sec: 8 }, { id: 110, price: 200, sec: 10 }]);
        expect(priceTicks()).toEqual([]);
        expect(getOpenCandle("pair-btc")).toMatchObject({ close: "200", volume: "1" });
    });

    it("a redelivered live update can't double-count", () => {
        send("update", [{ id: 120, price: 100, size: 2, sec: 1 }]);
        send("update", [{ id: 120, price: 100, size: 2, sec: 1 }, { id: 121, price: 101, size: 1, sec: 2 }]);
        expect(getOpenCandle("pair-btc")).toMatchObject({ volume: "3", tickCount: 2 });
        expect(pressure.samples).toHaveLength(2);
    });

    it("a stored candle is never overwritten by replayed trades; the still-open minute is gap-filled", async () => {
        // Minute M: live trades, last at M+50s.
        send("update", [{ id: 201, price: 100, size: 1, sec: 10 }, { id: 202, price: 110, size: 1, sec: 50 }]);
        // Disconnect at M+50s. Minute M+1 opens (first live trade after reconnect lands in it).
        vi.setSystemTime(T0 + 65_000);
        await flushDueCandles(); // M is complete → stored
        expect(storedCandles()).toEqual([{ ts: new Date(T0).toISOString(), open: 100, high: 110, low: 100, close: 110, volume: 2 }]);

        await reconnect();
        // Gap trades missed while disconnected: 2 in minute M (M+55s, M+58s), 2 in M+1.
        send("snapshot", [
            { id: 202, price: 110, size: 1, sec: 50 },
            { id: 203, price: 90, size: 7, sec: 55 }, { id: 204, price: 95, size: 7, sec: 58 },
            { id: 205, price: 120, size: 1, sec: 61 }, { id: 206, price: 121, size: 1, sec: 63 },
        ]);
        send("update", [{ id: 207, price: 122, size: 1, sec: 65 }]);

        // M+1 got its gap trades, in order; nothing from minute M leaked into it.
        expect(getOpenCandle("pair-btc")).toMatchObject({
            minuteKey: T0 + 60_000, open: "120", high: "122", low: "120", close: "122", volume: "3",
        });
        // Minute M is never re-stored with the replayed 90/95 trades.
        vi.setSystemTime(T0 + 125_000);
        await flushDueCandles();
        const stored = storedCandles();
        expect(stored.filter((c) => c.ts === new Date(T0).toISOString())).toHaveLength(1);
        expect(stored.find((c) => c.ts === new Date(T0 + 60_000).toISOString())).toMatchObject({ open: 120, close: 122, volume: 3 });
        // The gap's pressure samples still count (once each); last price is the newest trade.
        expect(pressure.samples.map((s) => s.notional)).toEqual([100, 110, 630, 665, 120, 121, 122]);
        expect(priceTicks().at(-1)).toBe(122);
    });

    it("gap entirely inside the already-stored minute: replayed trades never re-store it", async () => {
        send("update", [{ id: 301, price: 100, size: 1, sec: 10 }, { id: 302, price: 110, size: 1, sec: 50 }]);
        vi.setSystemTime(T0 + 61_000);
        await flushDueCandles();
        await reconnect();
        // Missed: two trades at M+55s / M+58s; nothing yet in M+1 (quiet symbol, or reconnect right at :00).
        send("snapshot", [{ id: 302, price: 110, sec: 50 }, { id: 303, price: 90, size: 7, sec: 55 }, { id: 304, price: 95, size: 7, sec: 58 }]);
        vi.setSystemTime(T0 + 70_000);
        await flushDueCandles();
        expect(storedCandles()).toEqual([{ ts: new Date(T0).toISOString(), open: 100, high: 110, low: 100, close: 110, volume: 2 }]);
        // The newest gap trade is still the current price, and its flow still counts.
        expect(priceTicks().at(-1)).toBe(95);
        expect(pressure.samples).toHaveLength(4);
    });

    it("a replayed trade for the previous minute can't replace the open candle of the current one", async () => {
        send("update", [{ id: 401, price: 100, size: 1, sec: 50 }]);
        await reconnect();
        vi.setSystemTime(T0 + 62_000);
        // Another source (Kraken's ticker, stamped with receive time) opens M+1 first.
        aggregateTick("pair-btc", { price: "130", volume: "0", ts: T0 + 61_000 });
        send("snapshot", [{ id: 401, price: 100, sec: 50 }, { id: 402, price: 90, size: 5, sec: 57 }]);
        expect(getOpenCandle("pair-btc")).toMatchObject({ minuteKey: T0 + 60_000, open: "130", close: "130", volume: "0" });
    });

    it("idless live trades are still processed (never silently starve the feed); idless snapshot trades are not", async () => {
        current().emit("message", Buffer.from(JSON.stringify({
            channel: "market_trades",
            events: [{ type: "update", trades: [
                { product_id: "BTC-USD", price: "101", size: "1", side: "BUY", time: at(2) },
                { product_id: "BTC-USD", price: "100", size: "1", side: "BUY", time: at(1) },
            ] }],
        })));
        expect(priceTicks()).toEqual([100, 101]);

        await reconnect();
        publish.mockClear();
        current().emit("message", Buffer.from(JSON.stringify({
            channel: "market_trades",
            events: [{ type: "snapshot", trades: [{ product_id: "BTC-USD", price: "50", size: "1", side: "BUY", time: at(0) }] }],
        })));
        expect(priceTicks()).toEqual([]);
    });
});
