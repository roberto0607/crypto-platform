import type { Candle, Point } from "./types";

const DAY_SEC = 86_400;

/**
 * VWAP — resets at each UTC midnight boundary. `tzOffsetSec` = the display
 * shift baked into `candle.time` on the chart (0 on the server); output times
 * keep it.
 */
export function computeVWAP(candles: Candle[], tzOffsetSec = 0): Point[] {
  if (candles.length === 0) return [];
  const result: Point[] = [];
  let cumPV = 0;
  let cumVol = 0;
  let currentDay = -1;

  for (const c of candles) {
    const day = Math.floor((c.time - tzOffsetSec) / DAY_SEC);
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
