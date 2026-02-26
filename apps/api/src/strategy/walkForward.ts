import type { Candle, TradeLog } from "./types.js";
import type { BacktestFlag } from "./backtestTypes.js";
import { WARMUP, SAMPLE_THRESHOLDS } from "./backtestTypes.js";
import { BacktestRunner, type EquityCurvePoint } from "./backtestRunner.js";
import {
  computeBacktestMetrics,
  type BacktestMetrics,
} from "./backtestMetrics.js";

// ── Constants ───────────────────────────────────────────────
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const WARMUP_PREFIX_DAYS = WARMUP.RECOMMENDED_DAYS;

// ── Config ──────────────────────────────────────────────────
export interface WalkForwardConfig {
  windowDays: number;
  isSplit: number;
  stepDays: number;
  accountEquity: number;
}

export const DEFAULT_WF_CONFIG: Omit<WalkForwardConfig, "accountEquity"> = {
  windowDays: 180,
  isSplit: 0.7,
  stepDays: 54,
};

// ── WFE Ratios ──────────────────────────────────────────────
export interface WFERatios {
  winRate: number | null;
  profitFactor: number | null;
  sharpeRatio: number | null;
  expectancy: number | null;
}

// ── Per-Window Result ───────────────────────────────────────
export interface WalkForwardWindow {
  windowIndex: number;
  isStartDate: string;
  isEndDate: string;
  oosStartDate: string;
  oosEndDate: string;
  isMetrics: BacktestMetrics;
  oosMetrics: BacktestMetrics;
  wfe: WFERatios;
}

// ── Aggregate Report ────────────────────────────────────────
export interface WalkForwardReport {
  windows: WalkForwardWindow[];
  meanOosSharpe: number | null;
  meanOosWinRate: number;
  meanWfe: WFERatios;
  oosEquityCurve: EquityCurvePoint[];
  passed: boolean;
  totalOosTrades: number;
  flags: BacktestFlag[];
}

// ── Run Walk-Forward ────────────────────────────────────────

export function runWalkForward(
  candles15m: Candle[],
  candles4H: Candle[],
  candles1D: Candle[],
  config: WalkForwardConfig,
): WalkForwardReport {
  const { windowDays, isSplit, stepDays, accountEquity } = config;
  const isDays = Math.round(windowDays * isSplit);
  const oosDays = windowDays - isDays;

  // Data range from 15m feed
  const dataStartMs = new Date(candles15m[0].timestamp).getTime();
  const dataEndMs = new Date(
    candles15m[candles15m.length - 1].timestamp,
  ).getTime();
  const totalDays = (dataEndMs - dataStartMs) / MS_PER_DAY;

  // Generate windows
  const windows: WalkForwardWindow[] = [];
  const allOosTrades: TradeLog[] = [];
  let idx = 0;

  for (
    let isStartDay = 0;
    isStartDay + windowDays <= totalDays;
    isStartDay += stepDays
  ) {
    idx++;

    const isStartMs = dataStartMs + isStartDay * MS_PER_DAY;
    const isEndMs = isStartMs + isDays * MS_PER_DAY;
    const oosEndMs = isStartMs + windowDays * MS_PER_DAY;

    // Slice all three feeds with warmup prefix
    const warmupStartMs = isStartMs - WARMUP_PREFIX_DAYS * MS_PER_DAY;
    const slice15m = sliceCandles(candles15m, warmupStartMs, oosEndMs);
    const slice4H = sliceCandles(candles4H, warmupStartMs, oosEndMs);
    const slice1D = sliceCandles(candles1D, warmupStartMs, oosEndMs);

    // Run backtest across full window
    const runner = new BacktestRunner({ accountEquity });
    const result = runner.run(slice15m, slice4H, slice1D);

    if (result.trades.length === 0) continue;

    // Partition trades: warmup trades discarded, IS and OOS split
    const isTrades = result.trades.filter((t) => {
      const ms = new Date(t.timestampEntry).getTime();
      return ms >= isStartMs && ms < isEndMs;
    });
    const oosTrades = result.trades.filter(
      (t) => new Date(t.timestampEntry).getTime() >= isEndMs,
    );

    // Metrics
    const isMetrics = computeBacktestMetrics(isTrades, accountEquity, isDays);
    const oosMetrics = computeBacktestMetrics(
      oosTrades,
      accountEquity,
      oosDays,
    );

    // WFE
    const wfe = computeWFE(isMetrics, oosMetrics);

    allOosTrades.push(...oosTrades);

    windows.push({
      windowIndex: idx,
      isStartDate: new Date(isStartMs).toISOString(),
      isEndDate: new Date(isEndMs).toISOString(),
      oosStartDate: new Date(isEndMs).toISOString(),
      oosEndDate: new Date(oosEndMs).toISOString(),
      isMetrics,
      oosMetrics,
      wfe,
    });
  }

  // ── Aggregates ──────────────────────────────────────────
  const meanOosSharpe = meanNullable(
    windows.map((w) => w.oosMetrics.sharpeRatio),
  );
  const meanOosWinRate =
    windows.length > 0
      ? windows.reduce((s, w) => s + w.oosMetrics.winRate, 0) / windows.length
      : 0;
  const meanWfe = computeMeanWFE(windows);

  // Concatenated OOS equity curve (non-overlapping, chronological)
  allOosTrades.sort(
    (a, b) =>
      new Date(a.timestampExit).getTime() -
      new Date(b.timestampExit).getTime(),
  );
  const oosEquityCurve = buildEquityCurve(allOosTrades, accountEquity);

  const totalOosTrades = allOosTrades.length;

  // ── Flags ───────────────────────────────────────────────
  const flags: BacktestFlag[] = [];

  // OOS degradation: IS positive expectancy → OOS negative
  let degradedCount = 0;
  for (const w of windows) {
    if (w.isMetrics.expectancy > 0 && w.oosMetrics.expectancy < 0) {
      degradedCount++;
    }
  }
  if (degradedCount > 0) flags.push("OOS_DEGRADATION");

  // ── Pass / Fail ─────────────────────────────────────────
  const meanOosPerWindow =
    windows.length > 0 ? totalOosTrades / windows.length : 0;

  const passed =
    windows.length >= 4 &&
    meanWfe.profitFactor !== null &&
    meanWfe.profitFactor >= 0.5 &&
    meanOosPerWindow >= SAMPLE_THRESHOLDS.MIN_TRADES_OOS_WINDOW &&
    (windows.length === 0 || degradedCount / windows.length < 0.5);

  return {
    windows,
    meanOosSharpe,
    meanOosWinRate,
    meanWfe,
    oosEquityCurve,
    passed,
    totalOosTrades,
    flags,
  };
}

// ── Slice Candles by Timestamp Range ────────────────────────

function sliceCandles(
  candles: Candle[],
  startMs: number,
  endMs: number,
): Candle[] {
  return candles.filter((c) => {
    const ms = new Date(c.timestamp).getTime();
    return ms >= startMs && ms < endMs;
  });
}

// ── WFE Computation ─────────────────────────────────────────

function computeWFE(is: BacktestMetrics, oos: BacktestMetrics): WFERatios {
  return {
    winRate: safeRatio(oos.winRate, is.winRate),
    profitFactor: safeRatio(oos.profitFactor, is.profitFactor),
    sharpeRatio:
      is.sharpeRatio !== null && oos.sharpeRatio !== null && is.sharpeRatio > 0
        ? oos.sharpeRatio / is.sharpeRatio
        : null,
    expectancy: safeRatio(oos.expectancy, is.expectancy),
  };
}

function safeRatio(num: number, den: number): number | null {
  if (den === 0 || !isFinite(den) || !isFinite(num)) return null;
  return num / den;
}

// ── Mean helpers ────────────────────────────────────────────

function meanNullable(values: (number | null)[]): number | null {
  const valid = values.filter((v): v is number => v !== null);
  if (valid.length === 0) return null;
  return valid.reduce((a, b) => a + b, 0) / valid.length;
}

function computeMeanWFE(windows: WalkForwardWindow[]): WFERatios {
  if (windows.length === 0) {
    return {
      winRate: null,
      profitFactor: null,
      sharpeRatio: null,
      expectancy: null,
    };
  }
  return {
    winRate: meanNullable(windows.map((w) => w.wfe.winRate)),
    profitFactor: meanNullable(windows.map((w) => w.wfe.profitFactor)),
    sharpeRatio: meanNullable(windows.map((w) => w.wfe.sharpeRatio)),
    expectancy: meanNullable(windows.map((w) => w.wfe.expectancy)),
  };
}

// ── OOS Equity Curve ────────────────────────────────────────

function buildEquityCurve(
  trades: TradeLog[],
  startingEquity: number,
): EquityCurvePoint[] {
  const curve: EquityCurvePoint[] = [];
  let cumPnl = 0;
  let peak = startingEquity;

  for (let i = 0; i < trades.length; i++) {
    cumPnl += trades[i].pnlUsd;
    const equity = startingEquity + cumPnl;
    if (equity > peak) peak = equity;
    const drawdownPct = peak > 0 ? ((peak - equity) / peak) * 100 : 0;

    curve.push({
      tradeIndex: i,
      timestamp: trades[i].timestampExit,
      cumulativePnl: cumPnl,
      equity,
      drawdownPct,
    });
  }

  return curve;
}
