import { describe, it, expect } from "vitest";
import { FIB_LEVELS, computeFibLevels } from "@/lib/drawings/fibonacciPrimitive";

// computeFibLevels is the pure derivation FibonacciPrimitive's render/hitTest
// both call on every repaint — pinned in isolation for the same reason as
// drawingPrimitiveShared.test.ts (mocking a real IChartApi/ISeriesApi would
// test the mock more than the math). Levels are never stored, only derived,
// which is what makes anchor-drag "just work" without extra wiring.

describe("computeFibLevels", () => {
    it("emits the 7 standard retracement levels, in order", () => {
        const levels = computeFibLevels({ time: 0, price: 100 }, { time: 10, price: 200 });
        expect(levels.map((l) => l.level)).toEqual(FIB_LEVELS);
        expect(levels).toHaveLength(7);
    });

    it("0% resolves to the first anchor's price and 100% to the second's, high-to-low", () => {
        const levels = computeFibLevels({ time: 0, price: 100 }, { time: 10, price: 200 });
        expect(levels[0]).toEqual({ level: 0, price: 100 });
        expect(levels[levels.length - 1]).toEqual({ level: 1, price: 200 });
    });

    it("interpolates correctly regardless of anchor direction (second anchor lower)", () => {
        // Drawn from a swing high down to a swing low — 0% still anchors p0.
        const levels = computeFibLevels({ time: 0, price: 200 }, { time: 10, price: 100 });
        expect(levels[0]!.price).toBe(200);
        expect(levels[levels.length - 1]!.price).toBe(100);
        const half = levels.find((l) => l.level === 0.5)!;
        expect(half.price).toBeCloseTo(150, 10);
    });

    it("computes the 61.8% level correctly", () => {
        const levels = computeFibLevels({ time: 0, price: 0 }, { time: 10, price: 1000 });
        const level618 = levels.find((l) => l.level === 0.618)!;
        expect(level618.price).toBeCloseTo(618, 10);
    });

    it("is a pure function of the two anchors — dragging one anchor changes only the levels dependent on it", () => {
        const before = computeFibLevels({ time: 0, price: 100 }, { time: 10, price: 200 });
        const after = computeFibLevels({ time: 0, price: 100 }, { time: 10, price: 300 });
        expect(before.find((l) => l.level === 0)!.price).toBe(after.find((l) => l.level === 0)!.price);
        expect(before.find((l) => l.level === 1)!.price).not.toBe(after.find((l) => l.level === 1)!.price);
    });
});
