import type { Candle, Point } from "./types";

/**
 * MACD (12/26/9).
 * Ported verbatim from apps/web/src/lib/indicators.ts — keep the two in
 * sync if this changes.
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

  const fastK = 2 / (fastPeriod + 1);
  const fastEma = new Float64Array(n);
  let sum = 0;
  for (let i = 0; i < fastPeriod; i++) sum += closes[i]!;
  fastEma[fastPeriod - 1] = sum / fastPeriod;
  for (let i = fastPeriod; i < n; i++) fastEma[i] = closes[i]! * fastK + fastEma[i - 1]! * (1 - fastK);

  const slowK = 2 / (slowPeriod + 1);
  const slowEma = new Float64Array(n);
  sum = 0;
  for (let i = 0; i < slowPeriod; i++) sum += closes[i]!;
  slowEma[slowPeriod - 1] = sum / slowPeriod;
  for (let i = slowPeriod; i < n; i++) slowEma[i] = closes[i]! * slowK + slowEma[i - 1]! * (1 - slowK);

  const macdStart = slowPeriod - 1;
  const macdLen = n - macdStart;
  const macdLine = new Float64Array(macdLen);
  for (let i = 0; i < macdLen; i++) macdLine[i] = fastEma[macdStart + i]! - slowEma[macdStart + i]!;

  const sigK = 2 / (signalPeriod + 1);
  const sigLine = new Float64Array(macdLen);
  sum = 0;
  for (let i = 0; i < signalPeriod; i++) sum += macdLine[i]!;
  sigLine[signalPeriod - 1] = sum / signalPeriod;
  for (let i = signalPeriod; i < macdLen; i++) sigLine[i] = macdLine[i]! * sigK + sigLine[i - 1]! * (1 - sigK);

  const outStart = signalPeriod - 1;
  const firstValidCandle = macdStart + outStart;
  const firstM = macdLine[outStart]!;
  const firstS = sigLine[outStart]!;

  const macd: Point[] = [];
  const signal: Point[] = [];
  const histogram: Point[] = [];
  for (let i = 0; i < n; i++) {
    const t = candles[i]!.time;
    if (i < firstValidCandle) {
      macd.push({ time: t, value: firstM });
      signal.push({ time: t, value: firstS });
      histogram.push({ time: t, value: firstM - firstS });
    } else {
      const mi = i - macdStart;
      const m = macdLine[mi]!;
      const s = sigLine[mi]!;
      macd.push({ time: t, value: m });
      signal.push({ time: t, value: s });
      histogram.push({ time: t, value: m - s });
    }
  }
  return { macd, signal, histogram };
}
