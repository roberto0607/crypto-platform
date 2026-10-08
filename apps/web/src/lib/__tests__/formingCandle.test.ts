import { describe, it, expect } from "vitest";

import type { Timeframe } from "@/api/endpoints/candles";
import {
    applyTick,
    bucketTime,
    planClosedCandle,
    reconcileForming,
    withForming,
    type Bar,
} from "@/lib/formingCandle";

const TIMEFRAMES: [Timeframe, number][] = [
    ["1m", 60],
    ["5m", 300],
    ["15m", 900],
    ["1h", 3600],
    ["4h", 14400],
    ["1d", 86400],
    ["1w", 604800],
];

// Monday 2026-10-05 00:00:00 UTC — a boundary for every timeframe, incl. 1w.
const MONDAY = Date.UTC(2026, 9, 5) / 1000;

const bar = (time: number, o: number, h: number, l: number, c: number): Bar => ({
    time, open: o, high: h, low: l, close: c,
});

describe("bucketTime", () => {
    it.each(TIMEFRAMES)("%s: floors into the bucket and rolls at the boundary", (tf, sec) => {
        const start = MONDAY + sec * 3; // a few buckets after a 1w-aligned Monday
        expect(bucketTime(start, tf)).toBe(start);
        expect(bucketTime(start + sec - 1, tf)).toBe(start);
        expect(bucketTime(start + sec, tf)).toBe(start + sec);
    });

    it("1w buckets start on Monday 00:00 UTC, not the epoch's Thursday", () => {
        const wed = MONDAY + 2 * 86400 + 5 * 3600;
        expect(bucketTime(wed, "1w")).toBe(MONDAY);
        expect(new Date(MONDAY * 1000).getUTCDay()).toBe(1);
    });
});

describe.each(TIMEFRAMES)("forming bar rules — %s", (tf, sec) => {
    const t0 = MONDAY + sec * 10; // last closed history bucket
    const t1 = t0 + sec;          // the forming bucket
    const t2 = t1 + sec;          // the next bucket
    const history = bar(t0, 100, 110, 90, 105);

    describe("applyTick", () => {
        it("extends the forming bar within its bucket (open kept, range widened)", () => {
            let live = applyTick(null, history, bucketTime(t1 + 1, tf), 106)!;
            live = applyTick(live, history, bucketTime(t1 + sec / 2, tf), 120)!;
            live = applyTick(live, history, bucketTime(t1 + sec - 1, tf), 95)!;
            expect(live).toEqual(bar(t1, 106, 120, 95, 95));
        });

        it("opens a new bar when the bucket rolls", () => {
            const live = bar(t1, 106, 120, 95, 101);
            expect(applyTick(live, history, bucketTime(t2, tf), 102)).toEqual(bar(t2, 102, 102, 102, 102));
        });

        it("ignores a tick for a bucket older than the series' last bar", () => {
            const live = bar(t2, 102, 102, 102, 102);
            expect(applyTick(live, history, t1, 999)).toBeNull();
            expect(applyTick(null, bar(t1, 1, 2, 0, 1), t0, 999)).toBeNull();
        });

        it("extends a history bar of the same bucket instead of resetting it to one tick", () => {
            const formingInHistory = bar(t1, 100, 112, 98, 104);
            expect(applyTick(null, formingInHistory, t1, 115)).toEqual(bar(t1, 100, 115, 98, 115));
        });

        it("never mutates the bar it extends", () => {
            const live = bar(t1, 106, 120, 95, 101);
            applyTick(live, history, t1, 130);
            expect(live).toEqual(bar(t1, 106, 120, 95, 101));
        });
    });

    describe("planClosedCandle", () => {
        it("closed bar arriving after the next bucket's ticks began: history only, series untouched", () => {
            // The "Cannot update oldest data" case: forming bar is at t2, server
            // flushes t1 late. update(t1) would throw; the forming bar must survive.
            expect(planClosedCandle(t1, t0, t2)).toEqual({
                history: "append", updateSeries: false, adoptAsLive: false,
            });
        });

        it("closed bar for the forming bucket: update the series, adopt server values", () => {
            expect(planClosedCandle(t1, t0, t1)).toEqual({
                history: "append", updateSeries: true, adoptAsLive: true,
            });
        });

        it("closed bar with no forming bar yet: append and draw", () => {
            expect(planClosedCandle(t1, t0, null)).toEqual({
                history: "append", updateSeries: true, adoptAsLive: false,
            });
        });

        it("redelivered last history bar: replace it, draw only if it is still the last bar", () => {
            expect(planClosedCandle(t0, t0, null).history).toBe("replace");
            expect(planClosedCandle(t0, t0, null).updateSeries).toBe(true);
            expect(planClosedCandle(t0, t0, t1).updateSeries).toBe(false);
        });

        it("bar older than the last history bar: ignored entirely", () => {
            expect(planClosedCandle(t0 - sec, t0, t1)).toEqual({
                history: "ignore", updateSeries: false, adoptAsLive: false,
            });
        });

        it("first bar on an empty history is appended", () => {
            expect(planClosedCandle(t0, null, null).history).toBe("append");
        });
    });

    describe("reconcileForming (history landing after ticks started)", () => {
        it("appends a newer forming bar", () => {
            const live = bar(t1, 106, 107, 105, 106);
            expect(reconcileForming([history], live)).toEqual({ bars: [history, live], live });
        });

        it("merges a forming bar of the same bucket into history's bar", () => {
            const partial = bar(t1, 100, 112, 98, 104);
            const live = bar(t1, 106, 115, 103, 107);
            const merged = bar(t1, 100, 115, 98, 107);
            expect(reconcileForming([history, partial], live)).toEqual({ bars: [history, merged], live: merged });
        });

        it("drops a forming bar that history already ends past", () => {
            expect(reconcileForming([history], bar(t0 - sec, 1, 1, 1, 1))).toEqual({ bars: [history], live: null });
        });

        it("keeps history untouched without a forming bar", () => {
            expect(reconcileForming([history], null)).toEqual({ bars: [history], live: null });
        });
    });

    describe("withForming", () => {
        it("appends a newer bar, replaces a same-time bar, skips an older one — never duplicates a time", () => {
            const live = bar(t1, 1, 1, 1, 1);
            expect(withForming([history], live)).toEqual([history, live]);
            const same = bar(t0, 2, 2, 2, 2);
            expect(withForming([history], same)).toEqual([same]);
            expect(withForming([history], bar(t0 - sec, 3, 3, 3, 3))).toEqual([history]);
            expect(withForming([], live)).toEqual([live]);
        });
    });
});
