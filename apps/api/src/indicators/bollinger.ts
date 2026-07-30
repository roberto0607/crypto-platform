import type { Candle, Point } from "./types";

/**
 * Bollinger Bands — SMA(period) ± multiplier * stddev.
 * Ported verbatim from apps/web/src/lib/indicators.ts — keep the two in
 * sync if this changes.
 */
export function computeBollingerBands(
  candles: Candle[],
  period = 20,
  multiplier = 2,
): { upper: Point[]; middle: Point[]; lower: Point[] } {
  const upper: Point[] = [];
  const middle: Point[] = [];
  const lower: Point[] = [];

  for (let i = period - 1; i < candles.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += candles[j]!.close;
    const sma = sum / period;

    let sqSum = 0;
    for (let j = i - period + 1; j <= i; j++) sqSum += (candles[j]!.close - sma) ** 2;
    const std = Math.sqrt(sqSum / period);

    const t = candles[i]!.time;
    upper.push({ time: t, value: sma + multiplier * std });
    middle.push({ time: t, value: sma });
    lower.push({ time: t, value: sma - multiplier * std });
  }
  return { upper, middle, lower };
}
