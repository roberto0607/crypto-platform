import { describe, it, expect } from "vitest";
import { candleWindow, replayClock, replayMarkPrice, replayTimeframe, timeframeFallbacks } from "../replayClock";

const MIN = 60_000;
const HOUR = 60 * MIN;

describe("replayTimeframe: candle size from the match length", () => {
    it.each([
        [5 * MIN, "1m"], [15 * MIN, "1m"], [HOUR, "1m"],
        [HOUR + 1, "5m"], [4 * HOUR, "5m"], [6 * HOUR, "5m"],
        [6 * HOUR + 1, "1h"], [24 * HOUR, "1h"], [7 * 24 * HOUR, "1h"],
    ] as const)("%d ms → %s", (ms, tf) => {
        expect(replayTimeframe(ms)).toBe(tf);
    });

    it("falls back to coarser sizes only", () => {
        expect(timeframeFallbacks(15 * MIN)).toEqual(["1m", "5m", "15m", "1h", "4h", "1d"]);
        expect(timeframeFallbacks(24 * HOUR)).toEqual(["1h", "4h", "1d"]);
    });
});

describe("candleWindow", () => {
    it("15 minutes from a minute boundary is 15 one-minute candles", () => {
        expect(candleWindow(10 * HOUR, 10 * HOUR + 15 * MIN, MIN)).toEqual({ from: 10 * HOUR, to: 10 * HOUR + 15 * MIN, buckets: 15 });
    });
    it("a start mid-bucket includes the bucket it falls in", () => {
        expect(candleWindow(10 * HOUR + 30_000, 10 * HOUR + 15 * MIN + 30_000, MIN).buckets).toBe(16);
    });
    it("an instant match still has one bucket", () => {
        expect(candleWindow(10 * HOUR, 10 * HOUR, MIN).buckets).toBe(1);
    });
});

describe("replayClock", () => {
    it("start, candle closes inside, events, end; sorted and unique", () => {
        const s = 100 * MIN;
        const e = s + 5 * MIN;
        expect(replayClock(s, e, [s, s + MIN, s + 2 * MIN, e, e + MIN], [s + 90_000, s + 2 * MIN, e])).toEqual(
            [s, s + MIN, s + 90_000, s + 2 * MIN, e],
        );
    });
    it("events outside the match are clamped into it", () => {
        expect(replayClock(1000, 2000, [], [500, 2500])).toEqual([1000, 2000]);
    });
});

describe("replayMarkPrice", () => {
    const candles = new Map([["BTC", [{ ts: 0, c: 100 }, { ts: MIN, c: 110 }]]]);
    it("a candle's close counts once it has closed", () => {
        const mark = replayMarkPrice(candles, MIN, []);
        expect(mark("BTC", MIN - 1)).toBeNull();
        expect(mark("BTC", MIN)).toBe(100);
        expect(mark("BTC", 2 * MIN)).toBe(110);
        expect(mark("ETH", 2 * MIN)).toBeNull();
    });
    it("a fill is the latest price from its time, and wins a tie with a close", () => {
        const mark = replayMarkPrice(candles, MIN, [{ pairId: "BTC", ts: MIN, price: "105" }, { pairId: "BTC", ts: 90_000, price: "107" }]);
        expect(mark("BTC", MIN)).toBe(105);
        expect(mark("BTC", 100_000)).toBe(107);
        expect(mark("BTC", 2 * MIN)).toBe(110);
    });
});
