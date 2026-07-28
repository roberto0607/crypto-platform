import { describe, it, expect } from "vitest";
import { computeMeasureStats, formatDuration, TIMEFRAME_SECONDS } from "@/lib/drawings/measureFormat";

// Measure never persists (transient — see CandlestickChart.tsx's
// updateMeasureState), so its live readout is the only user-visible
// behavior worth pinning. Pure functions, same isolation rationale as
// drawingPrimitiveShared.test.ts / fibonacciPrimitive.test.ts.

describe("computeMeasureStats", () => {
    it("computes a positive price delta and matching percentage for an up move", () => {
        const stats = computeMeasureStats({ time: 0, price: 100 }, { time: 3600, price: 110 }, TIMEFRAME_SECONDS["1h"]);
        expect(stats.priceDelta).toBe(10);
        expect(stats.pctDelta).toBeCloseTo(10, 10);
    });

    it("computes a negative price delta and percentage for a down move", () => {
        const stats = computeMeasureStats({ time: 0, price: 100 }, { time: 3600, price: 90 }, TIMEFRAME_SECONDS["1h"]);
        expect(stats.priceDelta).toBe(-10);
        expect(stats.pctDelta).toBeCloseTo(-10, 10);
    });

    it("time delta is always non-negative regardless of drag direction", () => {
        const forward = computeMeasureStats({ time: 0, price: 100 }, { time: 3600, price: 100 }, TIMEFRAME_SECONDS["1h"]);
        const backward = computeMeasureStats({ time: 3600, price: 100 }, { time: 0, price: 100 }, TIMEFRAME_SECONDS["1h"]);
        expect(forward.timeDeltaSec).toBe(3600);
        expect(backward.timeDeltaSec).toBe(3600);
    });

    it("candle count divides the time delta by the timeframe's interval", () => {
        const stats = computeMeasureStats({ time: 0, price: 100 }, { time: 12 * 3600, price: 100 }, TIMEFRAME_SECONDS["1h"]);
        expect(stats.candleCount).toBe(12);
    });

    it("rounds candle count to the nearest whole candle", () => {
        // 2.5 hours at a 1h timeframe rounds to 3 (banker's rounding not required here).
        const stats = computeMeasureStats({ time: 0, price: 100 }, { time: 2.5 * 3600, price: 100 }, TIMEFRAME_SECONDS["1h"]);
        expect(stats.candleCount).toBe(3);
    });

    it("does not divide by zero when start price is 0", () => {
        const stats = computeMeasureStats({ time: 0, price: 0 }, { time: 0, price: 50 }, TIMEFRAME_SECONDS["1h"]);
        expect(stats.pctDelta).toBe(0);
        expect(Number.isFinite(stats.pctDelta)).toBe(true);
    });
});

describe("formatDuration", () => {
    it("formats sub-minute durations as a floor label", () => {
        expect(formatDuration(30)).toBe("< 1m");
    });

    it("formats minutes only", () => {
        expect(formatDuration(45 * 60)).toBe("45m");
    });

    it("formats hours and minutes", () => {
        expect(formatDuration(3 * 3600 + 20 * 60)).toBe("3h 20m");
    });

    it("formats whole hours without a trailing 0m", () => {
        expect(formatDuration(4 * 3600)).toBe("4h");
    });

    it("formats days and hours", () => {
        expect(formatDuration(2 * 86400 + 5 * 3600)).toBe("2d 5h");
    });

    it("formats whole days without a trailing 0h", () => {
        expect(formatDuration(3 * 86400)).toBe("3d");
    });

    it("treats negative input as elapsed magnitude", () => {
        expect(formatDuration(-3600)).toBe("1h");
    });
});
