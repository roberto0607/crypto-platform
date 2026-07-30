import type { Candle, Point } from "./types";

/**
 * Per-candle Delta (estimated buy - sell volume).
 * Approximation: bullish candles split 70/30, bearish 30/70, doji 50/50.
 * Ported verbatim from apps/web/src/lib/indicators.ts — keep the two in
 * sync if this changes.
 */
export function computeCandleDelta(candles: Candle[]): Point[] {
  return candles.map((c) => {
    let ratio: number;
    if (c.close > c.open) ratio = 0.7;
    else if (c.close < c.open) ratio = 0.3;
    else ratio = 0.5;
    const buyVol = c.volume * ratio;
    const sellVol = c.volume * (1 - ratio);
    return { time: c.time, value: buyVol - sellVol };
  });
}
