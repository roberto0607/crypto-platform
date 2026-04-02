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
 * MACD (12/26/9)
 * Uses Float64Array for performance on large datasets.
 */
export interface MACDResult {
  macd: Point[];
  signal: Point[];
  histogram: Point[];
}

export function computeMACD(
  candles: Candle[],
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9,
): MACDResult {
  const n = candles.length;
  if (n < slowPeriod + signalPeriod) return { macd: [], signal: [], histogram: [] };

  const closes = new Float64Array(n);
  for (let i = 0; i < n; i++) closes[i] = candles[i]!.close;

  // Fast EMA
  const fastK = 2 / (fastPeriod + 1);
  const fastEma = new Float64Array(n);
  let sum = 0;
  for (let i = 0; i < fastPeriod; i++) sum += closes[i]!;
  fastEma[fastPeriod - 1] = sum / fastPeriod;
  for (let i = fastPeriod; i < n; i++) fastEma[i] = closes[i]! * fastK + fastEma[i - 1]! * (1 - fastK);

  // Slow EMA
  const slowK = 2 / (slowPeriod + 1);
  const slowEma = new Float64Array(n);
  sum = 0;
  for (let i = 0; i < slowPeriod; i++) sum += closes[i]!;
  slowEma[slowPeriod - 1] = sum / slowPeriod;
  for (let i = slowPeriod; i < n; i++) slowEma[i] = closes[i]! * slowK + slowEma[i - 1]! * (1 - slowK);

  // MACD line (from slowPeriod-1 onwards)
  const macdStart = slowPeriod - 1;
  const macdLen = n - macdStart;
  const macdLine = new Float64Array(macdLen);
  for (let i = 0; i < macdLen; i++) macdLine[i] = fastEma[macdStart + i]! - slowEma[macdStart + i]!;

  // Signal line = 9-period EMA of MACD
  const sigK = 2 / (signalPeriod + 1);
  const sigLine = new Float64Array(macdLen);
  sum = 0;
  for (let i = 0; i < signalPeriod; i++) sum += macdLine[i]!;
  sigLine[signalPeriod - 1] = sum / signalPeriod;
  for (let i = signalPeriod; i < macdLen; i++) sigLine[i] = macdLine[i]! * sigK + sigLine[i - 1]! * (1 - sigK);

  // Build output from signalPeriod-1 in macdLine (= macdStart + signalPeriod - 1 in candles)
  const outStart = signalPeriod - 1;
  const macd: Point[] = [];
  const signal: Point[] = [];
  const histogram: Point[] = [];
  for (let i = outStart; i < macdLen; i++) {
    const t = candles[macdStart + i]!.time;
    const m = macdLine[i]!;
    const s = sigLine[i]!;
    macd.push({ time: t, value: m });
    signal.push({ time: t, value: s });
    histogram.push({ time: t, value: m - s });
  }
  return { macd, signal, histogram };
}

/**
 * ATR — Average True Range (Wilder smoothing)
 * Uses Float64Array for performance.
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

  // First ATR = simple average of first `period` TR values (starting at index 1)
  let atrSum = 0;
  for (let i = 1; i <= period; i++) atrSum += tr[i]!;
  let atr = atrSum / period;

  const result: Point[] = [];
  result.push({ time: candles[period]!.time, value: atr });

  // Wilder smoothing
  for (let i = period + 1; i < n; i++) {
    atr = (atr * (period - 1) + tr[i]!) / period;
    result.push({ time: candles[i]!.time, value: atr });
  }
  return result;
}

/**
 * Per-candle Delta (estimated buy - sell volume)
 * Approximation: bullish candles split 70/30, bearish 30/70, doji 50/50.
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
