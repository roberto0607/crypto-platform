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

/**
 * Exponential Moving Average
 */
export function computeEMA(candles: Candle[], period: number): Point[] {
  if (candles.length < period) return [];
  const k = 2 / (period + 1);
  const result: Point[] = [];

  // Seed with SMA of first `period` candles
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

/**
 * VWAP — resets at each UTC midnight boundary
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

/**
 * Bollinger Bands — SMA(period) ± multiplier * stddev
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

/**
 * RSI — Relative Strength Index
 */
export function computeRSI(candles: Candle[], period = 14): Point[] {
  if (candles.length < period + 1) return [];
  const result: Point[] = [];

  let avgGain = 0;
  let avgLoss = 0;

  // First period — simple average
  for (let i = 1; i <= period; i++) {
    const diff = candles[i]!.close - candles[i - 1]!.close;
    if (diff > 0) avgGain += diff;
    else avgLoss += Math.abs(diff);
  }
  avgGain /= period;
  avgLoss /= period;

  const rs0 = avgLoss === 0 ? 100 : avgGain / avgLoss;
  result.push({ time: candles[period]!.time, value: 100 - 100 / (1 + rs0) });

  // Subsequent periods — smoothed average
  for (let i = period + 1; i < candles.length; i++) {
    const diff = candles[i]!.close - candles[i - 1]!.close;
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? Math.abs(diff) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    result.push({ time: candles[i]!.time, value: 100 - 100 / (1 + rs) });
  }
  return result;
}
