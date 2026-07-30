import type { Candle, Point } from "./types";

/**
 * VWAP — resets at each UTC midnight boundary.
 * Ported verbatim from apps/web/src/lib/indicators.ts — keep the two in
 * sync if this changes.
 */
export function computeVWAP(candles: Candle[]): Point[] {
  if (candles.length === 0) return [];
  const result: Point[] = [];
  let cumPV = 0;
  let cumVol = 0;
  let currentDay = -1;

  for (const c of candles) {
    const day = Math.floor(c.time / 86400);
    if (day !== currentDay) {
      cumPV = 0;
      cumVol = 0;
      currentDay = day;
    }
    const typical = (c.high + c.low + c.close) / 3;
    cumPV += typical * c.volume;
    cumVol += c.volume;
    if (cumVol > 0) {
      result.push({ time: c.time, value: cumPV / cumVol });
    }
  }
  return result;
}
