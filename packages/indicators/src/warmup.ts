import type { Candle } from "./types";

/**
 * Warm-up metadata: the index of the first candle whose value is real, so a
 * backtest can skip warm-up. What each function returns to the chart is
 * unchanged; for the padded ones (RSI, ATR, MACD) the bars before this index
 * repeat the first real value.
 *
 * "Real" means fully defined by the indicator's formula, not converged:
 * EMA/RSI/ATR/ADX/MACD still carry a trace of their seed that decays by
 * (1 - alpha) per bar (alpha = 2/(p+1) for EMA, 1/p for Wilder's RMA).
 *
 * Series that emit only real points (SMA, EMA, Bollinger, Pine ATR, ADX/DI,
 * UT Bot stop, prevPeriodLevelSeries) start exactly at this index.
 */
export const WARMUP = {
  sma: (period: number) => period - 1,
  ema: (period: number) => period - 1,
  bollinger: (period = 20) => period - 1,
  /** computeRSI: padded before this bar. */
  rsi: (period = 14) => period,
  /** computeATR (the chart's): padded before this bar. */
  atr: (period = 14) => period,
  pineAtr: (period = 14) => period - 1,
  /** computeMACD: padded before this bar. `fast` doesn't affect it. */
  macd: (_fast = 12, slow = 26, signal = 9) => slow + signal - 2,
  delta: () => 0,
  di: (diLength = 14) => diLength,
  adx: (diLength = 14, adxSmoothing = 14) => diLength + adxSmoothing - 1,
  utBotStop: (atrPeriod = 10) => atrPeriod - 1,
  /** A signal needs the previous bar's stop. */
  utBotSignals: (atrPeriod = 10) => atrPeriod,
  /** First bar that can CONFIRM a pivot (the pivot itself is `left` bars in). */
  swings: (left = 5, right = 5) => left + right,
  /**
   * First bar that can CONFIRM a support/resistance level: a pivot's
   * confirmation bar, once ATR exists (earlier confirmations are skipped).
   */
  supportResistance: (left = 10, right = 10, atrPeriod = 14) => Math.max(left + right, atrPeriod - 1),
  /**
   * VWAP resets at UTC midnight, so it is real from the first bar of the first
   * day the data covers from its start (bar 0 if the data starts at midnight).
   */
  vwap: (candles: Candle[], tzOffsetSec = 0) => {
    const first = candles[0];
    if (!first) return -1;
    const day = (c: Candle) => Math.floor((c.time - tzOffsetSec) / 86_400);
    if ((first.time - tzOffsetSec) % 86_400 === 0) return 0;
    return candles.findIndex((c) => day(c) > day(first));
  },
} as const;

/** The time of the first real bar, or null when the data is too short. */
export function firstRealTime(candles: Candle[], firstRealIndex: number): number | null {
  return firstRealIndex >= 0 && firstRealIndex < candles.length ? candles[firstRealIndex]!.time : null;
}
