/**
 * OI overlap check: Binance (the study's OI) vs Gate.io + OKX (the live
 * recorder's OI) on daily 16:00 UTC points, Pearson of 24h and 7d changes.
 */
import { describe, it, expect } from "vitest";
import { oiOverlapCheck, pearson, OI_OVERLAP } from "../oiOverlap";
import type { Point } from "../../../../indicators/shared";

const D = 86_400;
const T0 = Date.parse("2026-05-01T00:00:00Z") / 1000;
const AT = OI_OVERLAP.hourUtc * 3_600;

/** A wandering OI path: value on day i. */
const path = (i: number) => 10e9 * (1 + 0.2 * Math.sin(i / 3) + 0.1 * Math.cos(i / 1.7) + 0.003 * i);

describe("pearson", () => {
  it("is 1 for a linear map, −1 for an inverted one, NaN without variance", () => {
    expect(pearson([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 12);
    expect(pearson([1, 2, 3], [3, 2, 1])).toBeCloseTo(-1, 12);
    expect(pearson([1, 1, 1], [1, 2, 3])).toBeNaN();
  });
});

describe("oiOverlapCheck", () => {
  const days = 180;
  const daily = (f: (i: number) => number, hourOffset = AT): Point[] =>
    Array.from({ length: days }, (_, i) => ({ time: T0 + i * D + hourOffset, value: f(i) }));

  it("uses 16:00 UTC: OKX only has 16:00 daily points", () => {
    expect(OI_OVERLAP.hourUtc).toBe(16);
    expect(OI_OVERLAP.minCorrelation).toBe(0.8);
    const binance = daily(path);
    const gate = daily((i) => path(i) * 0.3);
    const okx = daily((i) => path(i) * 0.2);
    const r = oiOverlapCheck({ binance, gate, okx });
    expect(r.points).toBe(days);
    expect(r.n24h).toBe(days - 1);
    expect(r.n7d).toBe(days - 7);
    expect(r.r24h).toBeCloseTo(1, 9);
    expect(r.r7d).toBeCloseTo(1, 9);
    expect(r.pass).toBe(true);
  });

  it("ignores points at other hours, and a day missing in any source", () => {
    const binance = [...daily(path), ...daily((i) => path(i) * 5, 0)]; // 00:00 points must not be used
    const gate = daily((i) => path(i) * 0.3).filter((_, i) => i !== 50);
    const okx = daily((i) => path(i) * 0.2);
    const r = oiOverlapCheck({ binance, gate, okx });
    expect(r.points).toBe(days - 1);
    expect(r.n24h).toBe(days - 3); // pairs (49,50) and (50,51) gone
    expect(r.n7d).toBe(days - 7 - 2);
    expect(r.pass).toBe(true);
  });

  it("fails if either correlation is under 0.8", () => {
    const binance = daily(path);
    const gate = daily((i) => path(i) * 0.3 * (1 + 0.05 * Math.sin(i * 2.9)));
    const okx = daily((i) => path(i) * 0.2);
    const r = oiOverlapCheck({ binance, gate, okx });
    expect(r.r24h).toBeLessThan(0.8);
    expect(r.pass).toBe(false);
  });

  it("fails with no overlap at all", () => {
    const r = oiOverlapCheck({ binance: daily(path), gate: [], okx: [] });
    expect(r.points).toBe(0);
    expect(r.pass).toBe(false);
  });
});
