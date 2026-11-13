import { describe, it, expect } from "vitest";
import { computeATR, computeMACD, computeRSI, type Candle, type Point } from "@/lib/sharedIndicators";
import { applySeriesData, formingIndicators, liveIndicatorState, withFormingPoint } from "@/lib/liveIndicators";
import { btcCandles } from "./helpers/btcFixture";

/** Every value identical (Object.is), not just close. */
function expectSame(a: Point[], b: Point[]) {
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i++) {
        if (a[i]!.time !== b[i]!.time || !Object.is(a[i]!.value, b[i]!.value)) {
            throw new Error(`point ${i}: ${JSON.stringify(a[i])} !== ${JSON.stringify(b[i])}`);
        }
    }
}

/** A forming bar after `last`: random-ish OHLC around its close (deterministic). */
function forming(last: Candle, seed: number, sec: number): Candle {
    const r = (k: number) => Math.sin(seed * 12.9898 + k * 78.233) * 0.5; // [-0.5, 0.5]
    const open = last.close;
    const close = open * (1 + r(1) * 0.04);
    const high = Math.max(open, close) * (1 + Math.abs(r(2)) * 0.02);
    const low = Math.min(open, close) * (1 - Math.abs(r(3)) * 0.02);
    return { time: last.time + sec, open, high, low, close, volume: 0 };
}

const ON = { rsi: true, macd: true, atr: true };

describe.each([["4h", 14_400], ["1d", 86_400], ["1w", 604_800]] as const)("forming-bar RSI/MACD/ATR on %s BTC-USD", { timeout: 60_000 }, (tf, sec) => {
    const all = btcCandles(tf);

    it("=== the full recompute over [closed + forming], at every cut point", () => {
        for (let k = 1; k <= all.length; k++) {
            const closed = all.slice(0, k);
            const state = liveIndicatorState(closed, ON);
            for (const seed of [1, 2, 3]) {
                const f = forming(closed[k - 1]!, seed + k, sec);
                const full = [...closed, f];
                const got = formingIndicators(state, f);
                if (full.length >= 15) {
                    expectSame(got.rsi!, computeRSI(full, 14));
                    expectSame(got.atr!, computeATR(full, 14));
                } else {
                    expect(got.rsi).toBeNull();
                    expect(got.atr).toBeNull();
                }
                if (full.length >= 35) {
                    const m = computeMACD(full);
                    expectSame(got.macd!.macd, m.macd);
                    expectSame(got.macd!.signal, m.signal);
                    expectSame(got.macd!.histogram, m.histogram);
                } else {
                    expect(got.macd).toBeNull();
                }
            }
        }
    });

    it("leaves the closed points as the closed series' own objects (only the forming point is new)", () => {
        const closed = all.slice(0, 300);
        const state = liveIndicatorState(closed, ON);
        const got = formingIndicators(state, forming(closed[299]!, 7, sec));
        expect(got.rsi!.slice(0, -1).every((p, i) => p === state.closed.rsi![i])).toBe(true);
        expect(got.macd!.signal.slice(0, -1).every((p, i) => p === state.closed.macd!.signal[i])).toBe(true);
    });
});

describe("a forming bar that isn't after the last closed bar (as withForming handles it)", () => {
    it("same time → overlays the last closed bar; older → ignored; both === the full recompute", () => {
        const closed = btcCandles("4h").slice(0, 200);
        const state = liveIndicatorState(closed, ON);
        const last = closed[199]!;
        const same = { ...forming(closed[198]!, 3, 14_400), time: last.time };
        const got = formingIndicators(state, same);
        const overlaid = [...closed.slice(0, -1), same];
        expectSame(got.rsi!, computeRSI(overlaid, 14));
        expectSame(got.atr!, computeATR(overlaid, 14));
        expectSame(got.macd!.histogram, computeMACD(overlaid).histogram);
        const older = formingIndicators(state, { ...same, time: last.time - 14_400 });
        expectSame(older.rsi!, computeRSI(closed, 14));
        expectSame(older.macd!.signal, computeMACD(closed).signal);
    });
});

describe("only the indicators that are on", () => {
    it("skips the ones that are off", () => {
        const closed = btcCandles("4h").slice(0, 100);
        const state = liveIndicatorState(closed, { rsi: true, macd: false, atr: false });
        const got = formingIndicators(state, forming(closed[99]!, 1, 14_400));
        expect(got.rsi).not.toBeNull();
        expect(got.macd).toBeNull();
        expect(got.atr).toBeNull();
    });
});

/** Fake series with lightweight-charts' semantics: update() replaces a same-time last bar or appends a newer one. */
function fakeSeries() {
    const calls: string[] = [];
    let shown: Array<{ time: number; value: number }> = [];
    return {
        calls,
        shown: () => shown,
        setData(d: Array<{ time: number; value: number }>) { calls.push("setData"); shown = [...d]; },
        update(p: { time: number; value: number }) {
            calls.push("update");
            const last = shown[shown.length - 1];
            if (last && last.time === p.time) shown = [...shown.slice(0, -1), p];
            else if (!last || p.time > last.time) shown = [...shown, p];
            else throw new Error("Cannot update oldest data");
        },
    };
}
const toLW = (p: Point) => ({ time: p.time, value: p.value });
const pts = (from: number, n: number, v = 0): Point[] => Array.from({ length: n }, (_, i) => ({ time: from + i, value: v + i }));

describe("applySeriesData: update() only when it gives exactly what setData would", () => {
    it("forming point on the same closed series → update; the chart shows exactly the data", () => {
        const s = fakeSeries();
        const closed = pts(0, 5);
        applySeriesData(s, closed, toLW);
        const f1 = withFormingPoint(closed, { time: 5, value: 50 });
        applySeriesData(s, f1, toLW);
        const f2 = withFormingPoint(closed, { time: 5, value: 51 });
        applySeriesData(s, f2, toLW);
        expect(s.calls).toEqual(["setData", "update", "update"]);
        expect(s.shown()).toEqual(f2.map(toLW));
    });

    it("a new closed series, a forming bar in a new bucket, or a new series object → setData", () => {
        const s = fakeSeries();
        const closed = pts(0, 5);
        applySeriesData(s, withFormingPoint(closed, { time: 5, value: 50 }), toLW);
        // Forming moved to the next bucket before the close arrived: an update would keep the old point.
        applySeriesData(s, withFormingPoint(closed, { time: 6, value: 60 }), toLW);
        expect(s.shown()).toEqual([...closed, { time: 6, value: 60 }].map(toLW));
        // Close arrived: a new closed array.
        const closed2 = [...closed, { time: 5, value: 55 }];
        applySeriesData(s, closed2, toLW);
        expect(s.shown()).toEqual(closed2.map(toLW));
        // Same array again → nothing to do.
        applySeriesData(s, closed2, toLW);
        expect(s.calls).toEqual(["setData", "setData", "setData"]);
        const other = fakeSeries();
        applySeriesData(other, withFormingPoint(closed2, { time: 6, value: 1 }), toLW);
        expect(other.calls).toEqual(["setData"]);
    });

    it("a plain array that happens to share points is never treated as a forming update", () => {
        const s = fakeSeries();
        const closed = pts(0, 5);
        applySeriesData(s, closed, toLW);
        applySeriesData(s, [...closed, { time: 5, value: 9 }], toLW);
        expect(s.calls).toEqual(["setData", "setData"]);
    });
});
