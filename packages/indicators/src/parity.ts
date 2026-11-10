/**
 * Parity harness: runs every shared indicator over a candle fixture and
 * compares the outputs. Lives in the shared source so the API suite, the web
 * suite and the golden generator all run the exact same comparison.
 */
import type { Candle, Point } from "./types";
import { computeEMA } from "./ema";
import { computeRSI } from "./rsi";
import { computeATR } from "./atr";
import { computeMACD } from "./macd";
import { computeBollingerBands } from "./bollinger";
import { computeVWAP } from "./vwap";
import { computeCandleDelta } from "./delta";
import { prevPeriodHighLow } from "./keyLevels";

export interface CandleFixture {
  columns: string[];
  timeframes: Record<string, number[][]>;
}

export const PARITY_TIMEFRAME_SEC: Record<string, number> = { "4h": 14_400, "1d": 86_400, "1w": 604_800 };

/** Absolute tolerance for every compared value. */
export const PARITY_TOLERANCE = 1e-9;

export function fixtureCandles(rows: number[][]): Candle[] {
  return rows.map(([time, open, high, low, close, volume]) => ({
    time: time!, open: open!, high: high!, low: low!, close: close!, volume: volume!,
  }));
}

export type SeriesMap = Record<string, Point[]>;

/** Previous-period high/low as it would have read at each bar's close. */
function keyLevelSeries(candles: Candle[], candleSec: number, period: "day" | "week"): { high: Point[]; low: Point[] } {
  const high: Point[] = [];
  const low: Point[] = [];
  for (let i = 0; i < candles.length; i++) {
    const lv = prevPeriodHighLow(candles.slice(0, i + 1), { candleSec, period });
    if (!lv) continue;
    const t = candles[i]!.time;
    high.push({ time: t, value: lv.pdh });
    low.push({ time: t, value: lv.pdl });
  }
  return { high, low };
}

export function computeParitySeries(candles: Candle[], timeframeSec: number): SeriesMap {
  const macd = computeMACD(candles);
  const bb = computeBollingerBands(candles);
  const day = keyLevelSeries(candles, timeframeSec, "day");
  const week = keyLevelSeries(candles, timeframeSec, "week");
  return {
    ema20: computeEMA(candles, 20),
    ema50: computeEMA(candles, 50),
    ema200: computeEMA(candles, 200),
    rsi14: computeRSI(candles, 14),
    atr14: computeATR(candles, 14),
    macd: macd.macd,
    macdSignal: macd.signal,
    macdHistogram: macd.histogram,
    bbUpper: bb.upper,
    bbMiddle: bb.middle,
    bbLower: bb.lower,
    vwap: computeVWAP(candles),
    delta: computeCandleDelta(candles),
    pdh: day.high,
    pdl: day.low,
    pwh: week.high,
    pwl: week.low,
  };
}

/** Every point of every series must match: same names, lengths, times, values. */
export function compareSeries(actual: SeriesMap, expected: SeriesMap, tol = PARITY_TOLERANCE): string[] {
  const errors: string[] = [];
  const names = new Set([...Object.keys(actual), ...Object.keys(expected)]);
  for (const name of names) {
    const a = actual[name];
    const e = expected[name];
    if (!a || !e) { errors.push(`${name}: missing on one side`); continue; }
    if (a.length !== e.length) { errors.push(`${name}: length ${a.length} vs ${e.length}`); continue; }
    for (let i = 0; i < a.length; i++) {
      const pa = a[i]!;
      const pe = e[i]!;
      if (pa.time !== pe.time || !(Math.abs(pa.value - pe.value) <= tol)) {
        errors.push(`${name}[${i}]: (${pa.time}, ${pa.value}) vs (${pe.time}, ${pe.value})`);
        break;
      }
    }
  }
  return errors;
}

/**
 * A compact, committed stand-in for a full series: its length plus ~40 evenly
 * spaced points and the last 5. Keeps the golden file small while still
 * pinning warm-up, middle and the latest values.
 */
export function fingerprint(series: SeriesMap, samples = 40): SeriesMap {
  const out: SeriesMap = {};
  for (const [name, points] of Object.entries(series)) {
    const idx = new Set<number>();
    for (let k = 0; k < samples && points.length > 0; k++) idx.add(Math.floor((k * (points.length - 1)) / (samples - 1)));
    for (let i = Math.max(0, points.length - 5); i < points.length; i++) idx.add(i);
    out[name] = [...idx].sort((x, y) => x - y).map((i) => points[i]!);
    out[`${name}.length`] = [{ time: 0, value: points.length }];
  }
  return out;
}

/** Golden file shape: per timeframe, per series, [time, value] pairs. */
export type GoldenFile = Record<string, Record<string, [number, number][]>>;

export function toGolden(series: SeriesMap): Record<string, [number, number][]> {
  const out: Record<string, [number, number][]> = {};
  for (const [name, points] of Object.entries(series)) out[name] = points.map((p) => [p.time, p.value]);
  return out;
}

export function fromGolden(golden: Record<string, [number, number][]>): SeriesMap {
  const out: SeriesMap = {};
  for (const [name, pairs] of Object.entries(golden)) out[name] = pairs.map(([time, value]) => ({ time, value }));
  return out;
}
