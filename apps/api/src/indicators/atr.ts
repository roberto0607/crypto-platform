import type { Candle, Point } from "./types";

/**
 * ATR — Average True Range (Wilder smoothing).
 * Ported verbatim from apps/web/src/lib/indicators.ts — keep the two in
 * sync if this changes.
 */
export function computeATR(candles: Candle[], period = 14): Point[] {
  const n = candles.length;
  if (n < period + 1) return [];

  const tr = new Float64Array(n);
  tr[0] = candles[0]!.high - candles[0]!.low;
  for (let i = 1; i < n; i++) {
    const c = candles[i]!;
    const pc = candles[i - 1]!.close;
    tr[i] = Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc));
  }

  let atrSum = 0;
  for (let i = 1; i <= period; i++) atrSum += tr[i]!;
  let atr = atrSum / period;

  const atrValues = new Float64Array(n);
  atrValues[period] = atr;
  for (let i = period + 1; i < n; i++) {
    atr = (atr * (period - 1) + tr[i]!) / period;
    atrValues[i] = atr;
  }

  const firstValid = atrValues[period]!;
  const result: Point[] = [];
  for (let i = 0; i < n; i++) {
    result.push({ time: candles[i]!.time, value: i < period ? firstValid : atrValues[i]! });
  }
  return result;
}
