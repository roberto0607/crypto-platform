import type { Candle, Point } from "./types";

/**
 * Cumulative Volume Delta.
 *
 * Ported from apps/web/src/lib/cvd.ts with one deliberate change: the web
 * version shifts every timestamp by the BROWSER's local timezone offset
 * (`new Date().getTimezoneOffset()`) because Lightweight Charts renders
 * UTC timestamps in the viewer's local time. That's a chart-rendering
 * concern specific to a browser tab — meaningless (and non-deterministic
 * across server hosts/containers) server-side. This version returns plain
 * UTC epoch seconds, matching the `time` field on every other indicator
 * in this directory. Do not reintroduce a TZ shift here.
 *
 * Path A (real): uses buyVolume - sellVolume when side data exists.
 * Path B (proxy): wick-weighted price action estimate when side data is
 * missing.
 */

export interface CvdPoint {
  time: number; // epoch seconds (UTC)
  value: number;
}

export interface CvdDivergence {
  startTime: number;
  endTime: number;
  type: "bullish" | "bearish";
}

export type CvdDataSource = "REAL" | "PROXY" | "MIXED";

export interface CvdResult {
  values: CvdPoint[];
  divergences: CvdDivergence[];
  dataSource: CvdDataSource;
  realCount: number;
  totalCount: number;
}

export function computeCVD(candles: Candle[]): CvdResult {
  const values: CvdPoint[] = [];
  let cumulative = 0;
  let realCount = 0;

  for (const c of candles) {
    const buyVol = c.buyVolume ?? 0;
    const sellVol = c.sellVolume ?? 0;
    const hasRealData = buyVol > 0 || sellVol > 0;

    let delta: number;

    if (hasRealData) {
      delta = buyVol - sellVol;
      realCount++;
    } else {
      const candleRange = c.high - c.low;
      if (candleRange === 0 || c.volume === 0) {
        delta = 0;
      } else {
        const bodyTop = Math.max(c.open, c.close);
        const bodyBottom = Math.min(c.open, c.close);
        const upperWick = c.high - bodyTop;
        const lowerWick = bodyBottom - c.low;
        const bodyMove = c.close - c.open;

        const wickBias = (lowerWick - upperWick) / candleRange;
        const bodyBias = bodyMove / candleRange;
        const bias = wickBias * 0.4 + bodyBias * 0.6;
        delta = bias * c.volume;
      }
    }

    cumulative += delta;
    values.push({ time: c.time, value: cumulative });
  }

  const totalCount = candles.length;
  const realRatio = totalCount > 0 ? realCount / totalCount : 0;
  const dataSource: CvdDataSource =
    realRatio > 0.8 ? "REAL" : realCount > 0 ? "MIXED" : "PROXY";

  const divergences = detectCvdDivergence(candles, values);

  return { values, divergences, dataSource, realCount, totalCount };
}

/**
 * Detect divergences between price and CVD.
 * - Bullish divergence: price makes a lower low but CVD makes a higher low
 * - Bearish divergence: price makes a higher high but CVD makes a lower high
 */
function detectCvdDivergence(
  candles: Candle[],
  cvd: CvdPoint[],
  lookback = 20,
): CvdDivergence[] {
  if (candles.length < lookback * 2 || cvd.length < lookback * 2) return [];

  const divergences: CvdDivergence[] = [];

  for (let i = lookback; i < candles.length - 5; i++) {
    const priceNow = candles[i]!.close;
    const cvdNow = cvd[i]?.value ?? 0;
    const timeNow = cvd[i]?.time ?? 0;

    for (let j = i - lookback; j < i - 5; j++) {
      if (j < 0) continue;
      const pricePrev = candles[j]!.close;
      const cvdPrev = cvd[j]?.value ?? 0;
      const timePrev = cvd[j]?.time ?? 0;

      if (priceNow < pricePrev && cvdNow > cvdPrev) {
        if (isLocalLow(candles, i, 3) && isLocalLow(candles, j, 3)) {
          divergences.push({ startTime: timePrev, endTime: timeNow, type: "bullish" });
        }
      }

      if (priceNow > pricePrev && cvdNow < cvdPrev) {
        if (isLocalHigh(candles, i, 3) && isLocalHigh(candles, j, 3)) {
          divergences.push({ startTime: timePrev, endTime: timeNow, type: "bearish" });
        }
      }
    }
  }

  const deduped: CvdDivergence[] = [];
  for (const d of divergences) {
    const overlaps = deduped.some(
      (existing) => existing.type === d.type && Math.abs(existing.endTime - d.endTime) < 300,
    );
    if (!overlaps) deduped.push(d);
  }

  return deduped;
}

function isLocalLow(candles: Candle[], idx: number, range: number): boolean {
  const price = candles[idx]!.low;
  for (let j = idx - range; j <= idx + range; j++) {
    if (j === idx || j < 0 || j >= candles.length) continue;
    if (candles[j]!.low < price) return false;
  }
  return true;
}

function isLocalHigh(candles: Candle[], idx: number, range: number): boolean {
  const price = candles[idx]!.high;
  for (let j = idx - range; j <= idx + range; j++) {
    if (j === idx || j < 0 || j >= candles.length) continue;
    if (candles[j]!.high > price) return false;
  }
  return true;
}
