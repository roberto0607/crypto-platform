import type { Candle, Point } from "./types";

/**
 * Exponential Moving Average, seeded with the SMA of the first `period`
 * closes. First value at bar `period - 1`; no warm-up padding.
 */
export function computeEMA(candles: Candle[], period: number): Point[] {
  if (candles.length < period) return [];
  const k = 2 / (period + 1);
  const result: Point[] = [];

  // Seed with SMA of first `period` candles
  let sum = 0;
  for (let i = 0; i < period; i++) sum += candles[i]!.close;
  let ema = sum / period;
  result.push({ time: candles[period - 1]!.time, value: ema });

  for (let i = period; i < candles.length; i++) {
    ema = candles[i]!.close * k + ema * (1 - k);
    result.push({ time: candles[i]!.time, value: ema });
  }
  return result;
}
