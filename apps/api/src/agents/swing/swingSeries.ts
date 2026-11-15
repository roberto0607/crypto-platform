/**
 * Everything the Swing Agent reads at a 4h bar close, computed once over a
 * candle history with the shared indicator math (packages/indicators, the
 * chart's TradingView-verified copy). The live agent and the backtest both use
 * this, so they see the same numbers.
 *
 * No lookahead, by construction:
 * - 4h values at bar k (EMA, RSI, ADX, ATR, UT Bot, PDH/PWH) are causal: each
 *   depends on bars 0..k only.
 * - 4h S/R levels come from `activeSRLevelsAt(levels, k)`: only levels and
 *   touches confirmed by bar k's close, no later break.
 * - Daily/weekly values (closes, SMAs, daily S/R) are the ones in force at bar
 *   k's CLOSE instant by the HTF rule (`htfValueAt` / `srHtfLevelsAt`): only
 *   daily/weekly bars that had closed by then.
 * The test builds the snapshot from only the data known at k and checks it is
 * identical.
 *
 * Inputs: closed candles only, UTC epoch seconds, contiguous 4h bars; daily
 * bars on UTC days, weekly bars on Monday 00:00 UTC (as stored).
 */
import {
  activeSRLevelsAt,
  computeADX,
  computeEMA,
  computePineATR,
  computeRSI,
  computeSMA,
  computeSupportResistance,
  computeUTBot,
  htfValueAt,
  prevPeriodLevelSeries,
  srHtfLevelsAt,
  WARMUP,
  type Candle,
  type Point,
  type SRLevel,
} from "../../indicators/shared";
import { SWING_PARAMS as P } from "./swingParams";

const H4 = P.timeframeSec;
const D1 = 86_400;
const W1 = 604_800;

export interface SwingCandles {
  h4: Candle[];
  d1: Candle[];
  w1: Candle[];
}

export interface SwingLevel {
  id: string;
  tf: "4h" | "1d";
  role: "support" | "resistance";
  top: number;
  bottom: number;
  touches: number;
}

export interface SwingWindowBar {
  time: number;
  low: number;
  high: number;
  close: number;
  ema20: number | null;
  ema50: number | null;
}

/** The inputs at one closed 4h bar. null = not computable yet (warm-up). */
export interface SwingSnapshot {
  /** The 4h bar's open time; it closed at `closeTime`. */
  barTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  ema20: number | null;
  ema50: number | null;
  rsi14: number | null;
  adx: number | null;
  plusDI: number | null;
  minusDI: number | null;
  atr14: number | null;
  /** Bars k−2..k, oldest first (fewer at the very start). */
  window: SwingWindowBar[];
  utStop: number | null;
  utSignal: "buy" | "sell" | null;
  weekly: { barTime: number; close: number; sma50: number | null; sma200: number | null } | null;
  daily: { barTime: number; close: number; sma200: number | null } | null;
  /** Previous UTC day / week high-low in force for the next bar. */
  pdh: number | null;
  pdl: number | null;
  pwh: number | null;
  pwl: number | null;
  /**
   * Active (unbroken) S/R levels, nearest first: per timeframe, up to
   * `levelsPerSide` supports with bottom < close and resistances with top > close.
   */
  levels: SwingLevel[];
}

export interface SwingSeries {
  candles: SwingCandles;
  ema20: Float64Array;
  ema50: Float64Array;
  rsi14: Float64Array;
  adx: Float64Array;
  plusDI: Float64Array;
  minusDI: Float64Array;
  atr14: Float64Array;
  utStop: Float64Array;
  utSignal: Array<"buy" | "sell" | null>;
  pdh: Float64Array;
  pdl: Float64Array;
  pwh: Float64Array;
  pwl: Float64Array;
  sr4h: SRLevel[];
  sr1d: SRLevel[];
  d1Times: number[];
  weekly: { close: Point[]; time: Point[]; sma50: Point[]; sma200: Point[] };
  daily: { close: Point[]; time: Point[]; sma200: Point[] };
}

/** Points keyed by bar time → a per-bar array with NaN where there is no value. */
function align(h4: Candle[], index: Map<number, number>, pts: Point[], firstReal = 0): Float64Array {
  const out = new Float64Array(h4.length).fill(NaN);
  for (const p of pts) {
    const i = index.get(p.time);
    if (i !== undefined && i >= firstReal) out[i] = p.value;
  }
  return out;
}

const num = (v: number | undefined): number | null => (v === undefined || Number.isNaN(v) ? null : v);

export function buildSwingSeries(candles: SwingCandles): SwingSeries {
  const { h4, d1, w1 } = candles;
  const index = new Map(h4.map((c, i) => [c.time, i]));

  const adx = computeADX(h4, { diLength: P.adx.diLength, adxSmoothing: P.adx.adxSmoothing });
  const ut = computeUTBot(h4, { keyValue: P.utBot.keyValue, atrPeriod: P.utBot.atrPeriod });
  const utSignal: Array<"buy" | "sell" | null> = h4.map(() => null);
  for (const s of ut.signals) utSignal[s.index] = s.side;
  const day = prevPeriodLevelSeries(h4, { candleSec: H4, period: "day" });
  const week = prevPeriodLevelSeries(h4, { candleSec: H4, period: "week" });

  const closes = (cs: Candle[]): Point[] => cs.map((c) => ({ time: c.time, value: c.close }));
  const times = (cs: Candle[]): Point[] => cs.map((c) => ({ time: c.time, value: c.time }));

  return {
    candles,
    ema20: align(h4, index, computeEMA(h4, P.pullback.emaFast)),
    ema50: align(h4, index, computeEMA(h4, P.pullback.emaSlow)),
    // computeRSI pads the bars before its first real value; those are warm-up here.
    rsi14: align(h4, index, computeRSI(h4, P.pullback.rsiPeriod), WARMUP.rsi(P.pullback.rsiPeriod)),
    adx: align(h4, index, adx.adx),
    plusDI: align(h4, index, adx.plusDI),
    minusDI: align(h4, index, adx.minusDI),
    atr14: align(h4, index, computePineATR(h4, P.atrPeriod)),
    utStop: align(h4, index, ut.stop),
    utSignal,
    pdh: align(h4, index, day.high),
    pdl: align(h4, index, day.low),
    pwh: align(h4, index, week.high),
    pwl: align(h4, index, week.low),
    sr4h: computeSupportResistance(h4, { left: P.sr4h.left, right: P.sr4h.right }),
    sr1d: computeSupportResistance(d1, { left: P.sr1d.left, right: P.sr1d.right }),
    d1Times: d1.map((c) => c.time),
    weekly: {
      close: closes(w1),
      time: times(w1),
      sma50: computeSMA(w1, P.weeklySma.fast),
      sma200: computeSMA(w1, P.weeklySma.slow),
    },
    daily: { close: closes(d1), time: times(d1), sma200: computeSMA(d1, P.dailySma) },
  };
}

/** Nearest-first supports below and resistances above `close`, `perSide` each. */
function nearestLevels(levels: SRLevel[], tf: SwingLevel["tf"], close: number, perSide: number): SwingLevel[] {
  const view = (l: SRLevel): SwingLevel => ({
    id: l.id, tf, role: l.role, top: l.top, bottom: l.bottom, touches: l.touches.length,
  });
  const sup = levels.filter((l) => l.role === "support" && l.bottom < close).sort((a, b) => b.bottom - a.bottom);
  const res = levels.filter((l) => l.role === "resistance" && l.top > close).sort((a, b) => a.top - b.top);
  return [...sup.slice(0, perSide).map(view), ...res.slice(0, perSide).map(view)];
}

/** The inputs at the close of 4h bar `k`. */
export function snapshotAt(series: SwingSeries, k: number): SwingSnapshot {
  const { h4 } = series.candles;
  const c = h4[k];
  if (!c) throw new Error(`snapshotAt: no 4h bar at index ${k}`);
  const closeTime = c.time + H4;

  const window: SwingWindowBar[] = [];
  for (let i = Math.max(0, k - P.pullback.lookbackBars + 1); i <= k; i++) {
    const b = h4[i]!;
    window.push({ time: b.time, low: b.low, high: b.high, close: b.close, ema20: num(series.ema20[i]), ema50: num(series.ema50[i]) });
  }

  const wTime = htfValueAt(series.weekly.time, W1, closeTime);
  const weekly = wTime === null ? null : {
    barTime: wTime,
    close: htfValueAt(series.weekly.close, W1, closeTime)!,
    sma50: htfValueAt(series.weekly.sma50, W1, closeTime),
    sma200: htfValueAt(series.weekly.sma200, W1, closeTime),
  };
  const dTime = htfValueAt(series.daily.time, D1, closeTime);
  const daily = dTime === null ? null : {
    barTime: dTime,
    close: htfValueAt(series.daily.close, D1, closeTime)!,
    sma200: htfValueAt(series.daily.sma200, D1, closeTime),
  };

  const sr1d = srHtfLevelsAt(series.sr1d, series.d1Times, D1, closeTime).filter((l) => l.brokenIndex === null);
  const levels = [
    ...nearestLevels(activeSRLevelsAt(series.sr4h, k), "4h", c.close, P.levelsPerSide),
    ...nearestLevels(sr1d, "1d", c.close, P.levelsPerSide),
  ];

  return {
    barTime: c.time,
    closeTime,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    ema20: num(series.ema20[k]),
    ema50: num(series.ema50[k]),
    rsi14: num(series.rsi14[k]),
    adx: num(series.adx[k]),
    plusDI: num(series.plusDI[k]),
    minusDI: num(series.minusDI[k]),
    atr14: num(series.atr14[k]),
    window,
    utStop: num(series.utStop[k]),
    utSignal: series.utSignal[k] ?? null,
    weekly,
    daily,
    pdh: num(series.pdh[k]),
    pdl: num(series.pdl[k]),
    pwh: num(series.pwh[k]),
    pwl: num(series.pwl[k]),
    levels,
  };
}
