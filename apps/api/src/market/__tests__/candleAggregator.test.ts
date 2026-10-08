import { describe, it, expect, beforeEach, vi } from "vitest";
import client from "prom-client";

const query = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => ({ rows: [] })));
vi.mock("../../db/pool.js", () => ({ pool: { query } }));
vi.mock("../marketSymbols.js", () => ({ getMarketDataPairIds: async () => new Set(["p"]) }));
vi.mock("../../events/eventBus.js", () => ({ publish: vi.fn() }));

import { aggregateTick, flushDueCandles, getOpenCandle, getLastClosed, seedOpenCandle, __resetCandleAggregatorForTest } from "../candleAggregator";

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

describe("candleAggregator storage: every minute stored when it closes, REPLACE semantics", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(M);
        __resetCandleAggregatorForTest();
        query.mockClear();
    });

    const insertCalls = () => query.mock.calls.filter((c) => String(c[0]).includes("INSERT INTO candles"));

    it("a tick for the next minute stores the finished minute immediately (no flush interval needed)", async () => {
        tick(1, 100);
        tick(30, 104, 2);
        tick(61, 101); // minute M is over
        await vi.advanceTimersByTimeAsync(0);
        const calls = insertCalls();
        expect(calls).toHaveLength(1);
        expect((calls[0]![1] as unknown[]).slice(1, 7)).toEqual([new Date(M).toISOString(), "100", "104", "100", "104", "3"]);
        expect(getOpenCandle("p")).toMatchObject({ minuteKey: M + 60_000 });
        expect(getLastClosed("p")).toEqual({ minuteKey: M, close: "104" });
    });

    it("60 consecutive live minutes → 60 stored rows, each once", async () => {
        for (let m = 0; m <= 60; m++) tick(m * 60 + 5, 100 + m);
        await vi.advanceTimersByTimeAsync(0);
        vi.setSystemTime(M + 61 * 60_000 + 1_000);
        await flushDueCandles();
        const ts = inserts();
        expect(ts).toHaveLength(61);
        expect(new Set(ts).size).toBe(61);
    });

    it("the upsert replaces volume — it never adds to the stored row", async () => {
        tick(1, 100);
        tick(61, 101);
        await vi.advanceTimersByTimeAsync(0);
        const sql = String(insertCalls()[0]![0]);
        expect(sql).toMatch(/volume\s*=\s*EXCLUDED\.volume/);
        expect(sql).not.toMatch(/candles\.(buy_|sell_)?volume\s*\+/);
        expect(sql).not.toMatch(/GREATEST|LEAST/);
    });

    it("a quiet minute (no next tick) is still stored by the periodic flush", async () => {
        tick(10, 100);
        vi.setSystemTime(M + 65_000);
        await flushDueCandles();
        expect(inserts()).toEqual([new Date(M).toISOString()]);
    });

    it("seedOpenCandle: seeds the minute, marks it newest, older ticks are dropped", async () => {
        seedOpenCandle("p", { minuteKey: M, open: "90", high: "120", low: "80", close: "100", volume: "4" });
        tick(-5, 1); // previous minute: dropped
        tick(20, 105);
        expect(getOpenCandle("p")).toMatchObject({ open: "90", high: "120", low: "80", close: "105", volume: "5" });
        expect(await dropped()).toBe("tradr_candle_late_ticks_dropped_total 1");
    });

    it("seedOpenCandle ignores a snapshot older than the newest minute, and a minute already stored", async () => {
        tick(61, 200);
        seedOpenCandle("p", { minuteKey: M, open: "1", high: "1", low: "1", close: "1", volume: "1" });
        expect(getOpenCandle("p")).toMatchObject({ minuteKey: M + 60_000, open: "200" });

        vi.setSystemTime(M + 125_000);
        await flushDueCandles();
        seedOpenCandle("p", { minuteKey: M + 60_000, open: "1", high: "1", low: "1", close: "1", volume: "1" });
        expect(getOpenCandle("p")).toBeUndefined();
    });
});

describe("no candle writer adds to stored volume", () => {
    it("every INSERT INTO candles … ON CONFLICT in src replaces OHLCV", async () => {
        const { readFileSync, readdirSync, statSync } = await import("node:fs");
        const { join } = await import("node:path");
        const root = join(__dirname, "..", "..");
        const files: string[] = [];
        const walk = (d: string) => {
            for (const name of readdirSync(d)) {
                const p = join(d, name);
                if (statSync(p).isDirectory()) { if (name !== "__tests__") walk(p); }
                else if (p.endsWith(".ts")) files.push(p);
            }
        };
        walk(root);
        const offenders = files.filter((f) => {
            const src = readFileSync(f, "utf8");
            return /INSERT INTO candles[\s\S]*?ON CONFLICT/.test(src) &&
                /(volume|high|low)\s*=\s*(candles\.|GREATEST|LEAST)/.test(src);
        });
        expect(offenders).toEqual([]);
    });
});
