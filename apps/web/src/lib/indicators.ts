export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Point {
  time: number;
  value: number;
}

/**
 * Exponential Moving Average
 * EMA(0) = close(0)
 * multiplier = 2 / (period + 1)
 * EMA(i) = close(i) * multiplier + EMA(i-1) * (1 - multiplier)
 */
export function ema(candles: Candle[], period: number): Point[] {
  if (candles.length === 0) return [];
  const first = candles[0]!;
  const k = 2 / (period + 1);
  const result: Point[] = [];
  let prev = first.close;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]!;
    if (i === 0) {
      prev = c.close;
    } else {
      prev = c.close * k + prev * (1 - k);
    }
    if (i >= period - 1) {
      result.push({ time: c.time, value: prev });
    }
  }
  return result;
}

/**
 * Volume Weighted Average Price (session-based, resets at 00:00 UTC daily)
 */
export function vwap(candles: Candle[]): Point[] {
  if (candles.length === 0) return [];
  const result: Point[] = [];
  let cumTPV = 0;
  let cumVol = 0;
  let currentDay = -1;

  for (const c of candles) {
    const day = Math.floor(c.time / 86400);
    if (day !== currentDay) {
      cumTPV = 0;
      cumVol = 0;
      currentDay = day;
    }
    const tp = (c.high + c.low + c.close) / 3;
    cumTPV += tp * c.volume;
    cumVol += c.volume;
    if (cumVol > 0) {
      result.push({ time: c.time, value: cumTPV / cumVol });
    }
  }
  return result;
}

/**
 * Anchored VWAP — computed from a user-selected anchor timestamp forward
 */
export function anchoredVwap(candles: Candle[], anchorTime: number): Point[] {
  const result: Point[] = [];
  let cumTPV = 0;
  let cumVol = 0;
  let started = false;

  for (const c of candles) {
    if (!started) {
      if (c.time >= anchorTime) started = true;
      else continue;
    }
    const tp = (c.high + c.low + c.close) / 3;
    cumTPV += tp * c.volume;
    cumVol += c.volume;
    if (cumVol > 0) {
      result.push({ time: c.time, value: cumTPV / cumVol });
    }
  }
  return result;
}

/**
 * Previous Day High / Low
 * Scans for the last completed day boundary and returns its high/low
 */
export function prevDayHighLow(
  candles: Candle[],
): { pdh: number; pdl: number } | null {
  if (candles.length === 0) return null;

  const days = new Map<number, { high: number; low: number }>();
  for (const c of candles) {
    const day = Math.floor(c.time / 86400);
    const existing = days.get(day);
    if (!existing) {
      days.set(day, { high: c.high, low: c.low });
    } else {
      existing.high = Math.max(existing.high, c.high);
      existing.low = Math.min(existing.low, c.low);
    }
  }

  const sortedDays = [...days.keys()].sort((a, b) => a - b);
  if (sortedDays.length < 2) return null;

  const prevDayKey = sortedDays[sortedDays.length - 2];
  if (prevDayKey === undefined) return null;
  const prevDay = days.get(prevDayKey);
  if (!prevDay) return null;
  return { pdh: prevDay.high, pdl: prevDay.low };
}

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
