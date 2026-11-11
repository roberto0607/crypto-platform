import { describe, it, expect } from "vitest";
import { buildStudyMarkers, keyLevelSets, nudgeClear, utBotLine } from "@/lib/chartStudies";
import type { Candle } from "@/lib/indicators";

const H4 = 4 * 3600;
const MON = Date.UTC(2026, 9, 5) / 1000; // Monday 2026-10-05 00:00 UTC

/** 4h candles from `start`; high/low encode the bar's day so levels are easy to read. */
function bars(start: number, n: number): Candle[] {
    return Array.from({ length: n }, (_, i) => {
        const time = start + i * H4;
        const day = Math.floor((time - MON) / 86_400);
        return { time, open: 100, close: 100, high: 200 + day + (i % 6), low: 100 - day - (i % 6), volume: 1 };
    });
}

describe("keyLevelSets", () => {
    // Two full weeks + half of Monday of week 3 (6 bars/day): last closed bar
    // Mon 08:00, forming Mon 12:00 → yesterday is Sunday (day 13).
    const candles = bars(MON, 14 * 6 + 3);

    it("intraday/daily: PDH/PDL = the previous UTC day, PWH/PWL = the previous Monday–Sunday week", () => {
        const s = keyLevelSets(candles, { timeframe: "4h", candleSec: H4 })!;
        // Sunday of week 2 (day 13): highs 213..218, lows 87..82.
        expect(s.daily).toEqual({ high: 218, low: 82, labels: ["PDH", "PDL"] });
        // Previous week = days 7..13.
        expect(s.weekly).toEqual({ high: 218, low: 82, labels: ["PWH", "PWL"] });
    });

    it("mid-week the daily and weekly levels differ", () => {
        const s = keyLevelSets(candles.slice(0, 7 * 6 + 3 * 6), { timeframe: "4h", candleSec: H4 })!;
        expect(s.daily).toEqual({ high: 214, low: 86, labels: ["PDH", "PDL"] }); // forming Thu → Wed = day 9
        expect(s.weekly).toEqual({ high: 211, low: 89, labels: ["PWH", "PWL"] }); // days 0..6
    });

    it("needs a full previous week loaded for PWH/PWL", () => {
        const s = keyLevelSets(bars(MON + 2 * 86_400, 8 * 6), { timeframe: "4h", candleSec: H4 });
        expect(s.daily).not.toBeNull();
        expect(s.weekly).toBeNull();
    });

    it("1w: only the weekly pair, as the main cards (PWH/PWL), no duplicate", () => {
        const weeks = Array.from({ length: 4 }, (_, i) => ({ time: MON + i * 7 * 86_400, open: 1, close: 1, high: 10 + i, low: 5 - i, volume: 1 }));
        const s = keyLevelSets(weeks, { timeframe: "1w", candleSec: 7 * 86_400 })!;
        expect(s.daily).toEqual({ high: 13, low: 2, labels: ["PWH", "PWL"] });
        expect(s.weekly).toBeNull();
    });

    it("works in any display time zone (times shifted by tzOffsetSec)", () => {
        const tz = -5 * 3600;
        const shifted = candles.map((c) => ({ ...c, time: c.time + tz }));
        expect(keyLevelSets(shifted, { timeframe: "4h", candleSec: H4, tzOffsetSec: tz })).toEqual(
            keyLevelSets(candles, { timeframe: "4h", candleSec: H4 }),
        );
    });
});

describe("utBotLine", () => {
    it("colors each stop point by side: green while close is above it, red below", () => {
        const candles = [100, 110, 90].map((close, i) => ({ time: i, open: close, high: close, low: close, close, volume: 0 }));
        const line = utBotLine(candles, [{ time: 1, value: 105 }, { time: 2, value: 95 }]);
        expect(line).toEqual([
            { time: 1, value: 105, color: "#22c55e" },
            { time: 2, value: 95, color: "#ef4444" },
        ]);
    });
});

describe("buildStudyMarkers", () => {
    it("merges cross, UT Bot and swing markers into one list sorted by time", () => {
        const m = buildStudyMarkers({
            crosses: [{ time: 30, type: "golden" }],
            utSignals: [
                { index: 4, time: 40, side: "sell", price: 1 },
                { index: 1, time: 10, side: "buy", price: 1 },
            ],
            swings: {
                highs: [{ index: 2, time: 20, price: 5, confirmedIndex: 7, confirmedTime: 70 }],
                lows: [{ index: 2, time: 20, price: 1, confirmedIndex: 7, confirmedTime: 70 }],
            },
        });
        expect(m.map((x) => [x.time, x.text ?? "", x.position])).toEqual([
            [10, "Buy", "belowBar"],
            [20, "", "aboveBar"],
            [20, "", "belowBar"],
            [30, "GC", "belowBar"],
            [40, "Sell", "aboveBar"],
        ]);
    });

    it("nothing on → no markers", () => {
        expect(buildStudyMarkers({})).toEqual([]);
    });
});

describe("nudgeClear", () => {
    const box = (top: number, bottom: number) => ({ top, bottom });

    it("leaves a card that overlaps nothing where it is", () => {
        expect(nudgeClear(100, 10, [box(0, 50), box(200, 260)], -1, 4)).toBe(100);
    });

    it("pushes a card up past every box it would overlap, in turn", () => {
        // Card 90..110 hits 95..120 → 95-4-10 = 81 (71..91), which hits 60..80 → 60-4-10 = 46.
        expect(nudgeClear(100, 10, [box(95, 120), box(60, 80)], -1, 4)).toBe(46);
    });

    it("pushes down when dir = +1", () => {
        expect(nudgeClear(100, 10, [box(95, 120)], 1, 4)).toBe(134);
    });
});
