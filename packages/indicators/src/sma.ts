import type { Candle, Point } from "./types";

/**
 * Simple Moving Average of closes, any length. First value at bar
 * `period - 1`; nothing before it (no warm-up padding). Each window is summed
 * afresh, so long series don't accumulate rolling-sum rounding.
 */
export function computeSMA(candles: Candle[], period: number): Point[] {
  if (!(period >= 1) || candles.length < period) return [];
  const result: Point[] = [];
  for (let i = period - 1; i < candles.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += candles[j]!.close;
    result.push({ time: candles[i]!.time, value: sum / period });
  }
  return result;
}
