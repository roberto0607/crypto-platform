/**
 * Feature definitions for the confluence setup scanner, version 1. Approved
 * 2026-11-16 with the Phase 1–2 proposal. A change to any number here is a
 * new FEATURE_VERSION: old rows stay as they were recorded.
 *
 * Conventions:
 * - A row is as of the 4h bar's CLOSE (bar_time + 4h). Daily/weekly values
 *   are the ones in force at that instant (htfValueAt: only closed bars).
 * - "ATR" = Pine ATR 14 on 4h bars, unless a field says 1D.
 * - Distances to levels are in ATR, capped at `levelCapAtr` (also used when
 *   no level exists on that side: "far away").
 */
export const FEATURE_VERSION = 1;
export const FEATURE_SYMBOL = "BTC-USD";

export const FEATURE_PARAMS = {
  atrPeriod: 14,
  rsiPeriod: 14,
  macd: { fast: 12, slow: 26, signal: 9 },
  adx: { diLength: 14, adxSmoothing: 14 },
  weeklySma: [20, 50, 200] as const,
  dailySma: [50, 200] as const,
  /** Slope = SMA now ÷ SMA n bars earlier − 1. */
  weeklySlopeBars: 4,
  dailySlopeBars: 10,
  /** S/R pivots (left/right), the same as Swing v2. */
  sr1d: { left: 5, right: 5 },
  sr1w: { left: 3, right: 3 },
  levelCapAtr: 20,
  /** Room in R: stop distance = stopAtr × ATR. */
  stopAtr: 1.5,
  /** ATR % percentile window and minimum coverage of it. */
  atrRankWindowSec: 365 * 86_400,
  atrRankMinCoverage: 0.9,
  /** CVD (proxy) windows. */
  cvdShortSec: 86_400,
  cvdLongSec: 7 * 86_400,
  /** Event lookahead window for the *_within_7d flags. */
  eventWindowHours: 168,
} as const;

/** The study and its backfill: in-sample only. 2024-01-01 onward stays unread. */
export const FEATURE_PERIODS = {
  candleHistoryStart: "2015-07-20",
  inSampleStart: "2019-05-19",
  inSampleEndExclusive: "2024-01-01",
} as const;
