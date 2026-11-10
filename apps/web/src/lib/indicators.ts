// EMA/RSI/ATR/MACD/Bollinger/VWAP/Delta/PDH-PDL come from the shared source in
// packages/indicators, generated into ./sharedIndicators — the API and agents
// run the same copy, and a parity test + `sync-indicators --check` keep them
// equal. Edit packages/indicators/src, then `node scripts/sync-indicators.mjs`.
export {
  computeEMA,
  computeRSI,
  computeATR,
  computeMACD,
  computeBollingerBands,
  computeVWAP,
  computeCandleDelta,
  prevPeriodHighLow,
  type Candle,
  type Point,
  type MACDResult,
  type KeyLevelPeriod,
} from "./sharedIndicators";
import type { Candle, Point } from "./sharedIndicators";

/**
 * Swing Highs/Lows (fractals)
 * A swing high at bar i if: high(i) > high(j) for all j in [i-lookback, i+lookback], j !== i
 * Same logic inverted for swing lows. Default lookback = 5.
 */
export function swingPoints(
  candles: Candle[],
  lookback = 5,
): { highs: Point[]; lows: Point[] } {
  const highs: Point[] = [];
  const lows: Point[] = [];

  for (let i = lookback; i < candles.length - lookback; i++) {
    const ci = candles[i]!;
    let isHigh = true;
    let isLow = true;

    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      const cj = candles[j]!;
      if (cj.high >= ci.high) isHigh = false;
      if (cj.low <= ci.low) isLow = false;
      if (!isHigh && !isLow) break;
    }

    if (isHigh) highs.push({ time: ci.time, value: ci.high });
    if (isLow) lows.push({ time: ci.time, value: ci.low });
  }

  return { highs, lows };
}

/**
 * EMA 50/200 golden/death cross detection.
 *
 * A "golden cross" is the fast EMA (50) crossing from below to above the slow
 * EMA (200); a "death cross" is the reverse. computeEMA returns arrays with
 * DIFFERENT start offsets (ema50 begins at bar 50, ema200 at bar 200), so the
 * two arrays have different lengths and their indices do NOT line up. We must
 * align by TIMESTAMP: build a lookup from ema50, then walk ema200 (the
 * later-starting, limiting series) and compare values at the SAME time. A sign
 * flip in (ema50 - ema200) between consecutive COMMON timestamps is a cross.
 * Zipping by array index would compare mismatched times and report phantom
 * crosses — do not do it.
 */
export type EMACrossType = "golden" | "death";
export interface EMACross {
  time: number;
  type: EMACrossType;
}

export function detectEMACrosses(ema50: Point[], ema200: Point[]): EMACross[] {
  const fastByTime = new Map<number, number>();
  for (const p of ema50) fastByTime.set(p.time, p.value);

  const crosses: EMACross[] = [];
  let prevDiff: number | null = null;
  // Walk the slow (later-starting) series; it bounds the common-timestamp range.
  for (const slow of ema200) {
    const fast = fastByTime.get(slow.time);
    if (fast === undefined) continue; // no aligned fast value at this timestamp
    const diff = fast - slow.value;
    if (prevDiff !== null) {
      if (prevDiff < 0 && diff > 0) crosses.push({ time: slow.time, type: "golden" });
      else if (prevDiff > 0 && diff < 0) crosses.push({ time: slow.time, type: "death" });
    }
    prevDiff = diff;
  }
  return crosses; // ascending by time (ema200 is time-ordered)
}
