import { describe, it, expect } from "vitest";
import type { Candle } from "../../../indicators/shared";
import { rollup4h, rollupWeekly, closedBy } from "../featureCandles";

const H1 = 3_600;
const D1 = 86_400;
const c = (time: number, o: number, h: number, l: number, cl: number, v = 1): Candle => ({ time, open: o, high: h, low: l, close: cl, volume: v });

describe("rollup4h", () => {
  it("builds UTC-aligned 4h bars from four hourly bars", () => {
    const base = Date.parse("2021-01-01T04:00:00Z") / 1000;
    const h1 = [c(base, 10, 12, 9, 11, 1), c(base + H1, 11, 15, 10, 14, 2), c(base + 2 * H1, 14, 14, 8, 9, 3), c(base + 3 * H1, 9, 10, 7, 8, 4)];
    expect(rollup4h(h1)).toEqual([c(base, 10, 15, 7, 8, 10)]);
  });

  it("skips a bucket with a missing hour, and a partial first bucket (same rule as the candles rollup)", () => {
    const base = Date.parse("2021-01-01T00:00:00Z") / 1000;
    const h1 = [
      c(base + 2 * H1, 1, 1, 1, 1), c(base + 3 * H1, 1, 1, 1, 1), // 00:00 bucket, only 2 hours
      c(base + 4 * H1, 1, 2, 1, 2), c(base + 5 * H1, 2, 2, 2, 2), c(base + 7 * H1, 2, 2, 2, 2), // 04:00, 06:00 missing
      c(base + 8 * H1, 3, 3, 3, 3), c(base + 9 * H1, 3, 3, 3, 3), c(base + 10 * H1, 3, 3, 3, 3), c(base + 11 * H1, 3, 4, 3, 4),
    ];
    expect(rollup4h(h1).map((x) => x.time)).toEqual([base + 8 * H1]);
  });
});

describe("rollupWeekly", () => {
  it("builds Monday 00:00 UTC weeks from seven daily bars and skips incomplete weeks", () => {
    const mon = Date.parse("2021-01-04T00:00:00Z") / 1000; // a Monday
    const days = Array.from({ length: 7 }, (_, i) => c(mon + i * D1, 100 + i, 110 + i, 90 - i, 101 + i, 1));
    const partial = [c(mon + 7 * D1, 1, 1, 1, 1), c(mon + 8 * D1, 1, 1, 1, 1)];
    expect(rollupWeekly([...days, ...partial])).toEqual([c(mon, 100, 116, 84, 107, 7)]);
  });
});

describe("closedBy", () => {
  it("keeps only bars whose close is at or before t", () => {
    const bars = [c(0, 1, 1, 1, 1), c(H1, 1, 1, 1, 1), c(2 * H1, 1, 1, 1, 1)];
    expect(closedBy(bars, H1, 2 * H1).map((b) => b.time)).toEqual([0, H1]);
  });
});
