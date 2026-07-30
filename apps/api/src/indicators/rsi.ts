import type { Candle, Point } from "./types";

/**
 * RSI — Relative Strength Index.
 * Ported verbatim from apps/web/src/lib/indicators.ts — keep the two in
 * sync if this changes.
 */
export function computeRSI(candles: Candle[], period = 14): Point[] {
  const n = candles.length;
  if (n < period + 1) return [];

  let avgGain = 0;
  let avgLoss = 0;

  for (let i = 1; i <= period; i++) {
    const diff = candles[i]!.close - candles[i - 1]!.close;
    if (diff > 0) avgGain += diff;
    else avgLoss += Math.abs(diff);
  }
  avgGain /= period;
  avgLoss /= period;

  const rs0 = avgLoss === 0 ? 100 : avgGain / avgLoss;
  const rsiValues = new Float64Array(n);
  rsiValues[period] = 100 - 100 / (1 + rs0);

  for (let i = period + 1; i < n; i++) {
    const diff = candles[i]!.close - candles[i - 1]!.close;
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? Math.abs(diff) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    rsiValues[i] = 100 - 100 / (1 + rs);
  }

  const firstValid = rsiValues[period]!;
  const result: Point[] = [];
  for (let i = 0; i < n; i++) {
    result.push({ time: candles[i]!.time, value: i < period ? firstValid : rsiValues[i]! });
  }
  return result;
}
