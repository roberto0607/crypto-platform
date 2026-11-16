/**
 * Swing Agent v2 numbers, approved 2026-11-15 BEFORE any v2 backtest ran.
 * Change them only with a new approval, never to fit a backtest. v1
 * (swingParams.ts) stays frozen so its report still reproduces.
 *
 * What changed from v1, and why (from the v1 evidence, not tuned to it):
 * - Weekly bias = last closed weekly close vs SMA 50w only. v1's "above both
 *   SMA 50w and SMA 200w" left 23.5% of bars neutral.
 * - Room check on daily (pivots 5/5) and weekly (pivots 3/3, the chart's Auto
 *   value) S/R only, >= 1.0R. v1's 4h levels sat a median 0.61R away, so a
 *   1.5R room almost never passed.
 * - No target and no time stop: exit when a 4h close crosses EMA 50 (the
 *   structure the entry required), at the next 4h open. v1's 2R cap made an
 *   18% win rate unprofitable by construction. The initial stop stays as the
 *   resting hard stop and never moves.
 * - Variant A only; B is dropped.
 * Everything else (daily filter, ADX, setup, stop, risk, limits) is v1's.
 */
import { SWING_PARAMS } from "./swingParams";

export const SWING_PARAMS_V2 = {
  timeframeSec: SWING_PARAMS.timeframeSec,

  /** Bias: last closed weekly close > SMA → long only, < SMA → short only. */
  weeklySma: 50,
  /** Unchanged: the last closed daily close vs SMA 200d must agree with the bias. */
  dailySma: SWING_PARAMS.dailySma,
  /** Unchanged: 4h ADX(14, 14) >= 20. */
  adx: SWING_PARAMS.adx,
  /** Unchanged: the v1 Variant A pullback setup. */
  pullback: SWING_PARAMS.pullback,
  atrPeriod: SWING_PARAMS.atrPeriod,
  /** Unchanged: the initial stop rule (4h/1d structure or 1.5 ATR, 0.5%–8%). */
  stop: SWING_PARAMS.stop,

  /** Weekly S/R pivot length (left = right): the chart's Auto value for 1w. */
  sr1w: { left: 3, right: 3 },
  room: {
    /** The nearest opposing DAILY or WEEKLY S/R zone edge must be >= this many R away. */
    minR: 1.0,
    timeframes: ["1d", "1w"] as const,
  },
  exit: {
    /** Long: exit when a 4h close is below EMA(50); short: above. Fills at the next 4h open. */
    ema: SWING_PARAMS.pullback.emaSlow,
  },

  risk: SWING_PARAMS.risk,
  /** Unchanged limits, minus the time stop. */
  limits: {
    dailyLossPct: SWING_PARAMS.limits.dailyLossPct,
    maxEntriesPerDay: SWING_PARAMS.limits.maxEntriesPerDay,
    cooldownSec: SWING_PARAMS.limits.cooldownSec,
    drawdownHaltPct: SWING_PARAMS.limits.drawdownHaltPct,
  },
} as const;

/** Baselines for every v2 report. Fixed with the v2 rules. */
export const SWING_BASELINES = {
  /** (a) and (b): long while the last weekly close > SMA 50w, else flat. Long only. */
  weeklySma: 50,
  /** (b): stop = entry reference (the weekly close) − 2 × weekly ATR(14), fixed; 1% risk, ≤ 1x notional. */
  stopAtrMult: 2,
  atrPeriod: 14,
  riskPerTrade: 0.01,
  maxNotionalOfEquity: 1.0,
} as const;

/** The pass bars, fixed 2026-11-15 before the run. */
export const SWING_V2_PASS_BAR = {
  inSample: {
    /** Average R per trade in the fees+slippage ×2 run must be > this. */
    minStressExpectancyR: 0,
    /** v2 MAR (CAGR ÷ max DD, base costs) must be >= baseline (b)'s. */
    marAtLeastBaselineB: true,
    /** Fewer trades = INCONCLUSIVE, not a pass. */
    minTrades: 30,
  },
  outOfSample: {
    /** Average R per trade at normal costs must be > this. */
    minExpectancyR: 0,
    maxDrawdownPct: 0.2,
    /** v2 MAR must be >= (1 − this) × baseline (b)'s MAR. */
    marWithinOfBaselineB: 0.25,
  },
} as const;

/** The two periods. OOS runs once, only after the in-sample result is approved. */
export const SWING_V2_PERIODS = {
  inSample: { start: "2019-05-01", endExclusive: "2024-01-01" },
  outOfSample: { start: "2024-01-01" },
} as const;
