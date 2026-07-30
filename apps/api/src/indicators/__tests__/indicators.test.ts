import { describe, it, expect } from "vitest";
import { computeEMA } from "../ema";
import { computeRSI } from "../rsi";
import { computeATR } from "../atr";
import type { Candle } from "../types";

function candle(time: number, overrides: Partial<Candle> = {}): Candle {
  return { time, open: 100, high: 100, low: 100, close: 100, volume: 1, ...overrides };
}

describe("computeEMA", () => {
  it("matches a hand-computed EMA(3) over closes [1,2,3,4,5]", () => {
    // Seed = SMA(1,2,3) = 2. k = 2/(3+1) = 0.5.
    // ema[3] = 4*0.5 + 2*0.5 = 3. ema[4] = 5*0.5 + 3*0.5 = 4.
    const candles = [1, 2, 3, 4, 5].map((close, i) => candle(i, { close }));
    const result = computeEMA(candles, 3);
    expect(result).toEqual([
      { time: 2, value: 2 },
      { time: 3, value: 3 },
      { time: 4, value: 4 },
    ]);
  });

  it("returns [] when there are fewer candles than the period", () => {
    const candles = [1, 2].map((close, i) => candle(i, { close }));
    expect(computeEMA(candles, 3)).toEqual([]);
  });
});

describe("computeRSI", () => {
  it("asymptotes near 100 for a strictly increasing close series (no losses)", () => {
    // period=14 needs 15 candles minimum for the first output point.
    // NB: the algorithm special-cases avgLoss === 0 as rs = 100 (not
    // Infinity), so RSI = 100 - 100/(1+100) = 99.0099..., not exactly 100.
    const candles = Array.from({ length: 16 }, (_, i) => candle(i, { close: 100 + i }));
    const result = computeRSI(candles, 14);
    expect(result.length).toBeGreaterThan(0);
    for (const p of result) expect(p.value).toBeCloseTo(99.00990099009901, 10);
  });

  it("is 0 for a strictly decreasing close series (no gains)", () => {
    const candles = Array.from({ length: 16 }, (_, i) => candle(i, { close: 200 - i }));
    const result = computeRSI(candles, 14);
    expect(result.length).toBeGreaterThan(0);
    for (const p of result) expect(p.value).toBeCloseTo(0, 10);
  });
});

describe("computeATR", () => {
  it("converges to the constant true range on a fixed-range series", () => {
    // open = close = 100, high = 105, low = 95 for every candle => no gaps,
    // so TR = high - low = 10 for every bar, and Wilder-smoothed ATR of a
    // constant series stays exactly that constant.
    const candles = Array.from({ length: 20 }, (_, i) =>
      candle(i, { open: 100, close: 100, high: 105, low: 95 }),
    );
    const result = computeATR(candles, 14);
    expect(result.length).toBeGreaterThan(0);
    for (const p of result) expect(p.value).toBeCloseTo(10, 10);
  });

  it("returns [] when there are fewer than period + 1 candles", () => {
    const candles = Array.from({ length: 10 }, (_, i) => candle(i));
    expect(computeATR(candles, 14)).toEqual([]);
  });
});
