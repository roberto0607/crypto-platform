import type { Candle, Point } from "./types";

/**
 * Exponential Moving Average.
 * Ported verbatim from apps/web/src/lib/indicators.ts — keep the two in
 * sync if this changes (server does not import the web copy, see
 * apps/api/src/indicators/index.ts).
 */
export function computeEMA(candles: Candle[], period: number): Point[] {
  if (candles.length < period) return [];
  const k = 2 / (period + 1);
  const result: Point[] = [];

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
