import { describe, it, expect, beforeEach, vi } from "vitest";
import client from "prom-client";

const query = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => ({ rows: [] })));
vi.mock("../../db/pool.js", () => ({ pool: { query } }));
vi.mock("../marketSymbols.js", () => ({ getMarketDataPairIds: async () => new Set(["p"]) }));
vi.mock("../../events/eventBus.js", () => ({ publish: vi.fn() }));

import { aggregateTick, flushDueCandles, getOpenCandle, __resetCandleAggregatorForTest } from "../candleAggregator";

const M = Date.UTC(2026, 9, 8, 14, 0, 0);
const tick = (sec: number, price: number, volume = 1) => aggregateTick("p", { price: String(price), volume: String(volume), ts: M + sec * 1000 });
const inserts = () => query.mock.calls.filter((c) => String(c[0]).includes("INSERT INTO candles")).map((c) => (c[1] as unknown[])[1]);
const dropped = async () => (await client.register.getSingleMetricAsString("tradr_candle_late_ticks_dropped_total")).split("\n").at(-1);

describe("candleAggregator late ticks", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(M);
        __resetCandleAggregatorForTest();
        query.mockClear();
    });

    it("same-minute ticks update the open candle", () => {
        tick(1, 100);
        tick(2, 105);
        tick(3, 98);
        expect(getOpenCandle("p")).toMatchObject({ minuteKey: M, open: "100", high: "105", low: "98", close: "98", volume: "3" });
    });

    it("a tick for an older minute is dropped and leaves the current candle alone", async () => {
        tick(61, 200);
        tick(59, 50, 9);
        expect(getOpenCandle("p")).toMatchObject({ minuteKey: M + 60_000, open: "200", close: "200", volume: "1" });
        expect(await dropped()).toBe("tradr_candle_late_ticks_dropped_total 1");
    });

    it("a tick for a minute that was already flushed doesn't reopen it, so it's stored exactly once", async () => {
        tick(10, 100);
        vi.setSystemTime(M + 61_000);
        await flushDueCandles();
        expect(getOpenCandle("p")).toBeUndefined();

        tick(59, 50, 9); // late: minute M is already stored
        expect(getOpenCandle("p")).toBeUndefined();
        await flushDueCandles();
        expect(inserts()).toEqual([new Date(M).toISOString()]);
    });

    it("the next minute still opens normally after a flush", () => {
        tick(10, 100);
        tick(61, 101);
        expect(getOpenCandle("p")).toMatchObject({ minuteKey: M + 60_000, open: "101" });
    });
});
