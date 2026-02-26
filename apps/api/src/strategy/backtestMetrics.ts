import type { TradeLog, Regime, ExitReason } from "./types.js";
import { SAMPLE_THRESHOLDS } from "./backtestTypes.js";

// ── Core Metrics ────────────────────────────────────────────
// Shared shape between aggregate and per-regime buckets.

export interface CoreMetrics {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  expectancy: number;
  sharpeRatio: number | null;
  maxDrawdownPct: number;
  maxDrawdownUsd: number;
  profitFactor: number;
  avgRPerTrade: number;
  totalPnlUsd: number;
  totalPnlPct: number;
  avgWinUsd: number;
  avgLossUsd: number;
  avgWinR: number;
  avgLossR: number;
  largestWinUsd: number;
  largestLossUsd: number;
  avgHoldingMinutes: number;
  maxConsecutiveWins: number;
  maxConsecutiveLosses: number;
  recoveryFactor: number;
  sampleFlag: "OK" | "LOW_SAMPLE" | "LOW_CONFIDENCE";
}

// ── Exit Reason Row ─────────────────────────────────────────

export interface ExitReasonRow {
  reason: ExitReason;
  count: number;
  pctOfTotal: number;
  avgR: number;
  avgPnlUsd: number;
}

// ── Full Backtest Metrics ───────────────────────────────────

export interface BacktestMetrics extends CoreMetrics {
  byRegime: Partial<Record<Regime, CoreMetrics>>;
  byExitReason: ExitReasonRow[];
}

// ── Public Entry Point ──────────────────────────────────────

export function computeBacktestMetrics(
  trades: TradeLog[],
  startingEquity: number,
  backtestDays: number,
): BacktestMetrics {
  const core = computeCoreMetrics(trades, startingEquity, backtestDays, false);

  // Regime breakdown
  const regimes: Regime[] = ["TREND_UP", "TREND_DOWN", "RANGE"];
  const byRegime: Partial<Record<Regime, CoreMetrics>> = {};
  for (const r of regimes) {
    const bucket = trades.filter((t) => t.regime === r);
    if (bucket.length > 0) {
      byRegime[r] = computeCoreMetrics(bucket, startingEquity, backtestDays, true);
    }
  }

  // Exit reason breakdown
  const reasons: ExitReason[] = [
    "TP_HIT",
    "SL_HIT",
    "TRAILING_STOP",
    "TIME_EXIT",
    "INVALIDATION",
    "MANUAL",
  ];
  const byExitReason: ExitReasonRow[] = [];
  for (const reason of reasons) {
    const bucket = trades.filter((t) => t.exitReason === reason);
    if (bucket.length === 0) continue;
    const sumR = bucket.reduce((s, t) => s + t.rMultipleResult, 0);
    const sumPnl = bucket.reduce((s, t) => s + t.pnlUsd, 0);
    byExitReason.push({
      reason,
      count: bucket.length,
      pctOfTotal: trades.length > 0 ? (bucket.length / trades.length) * 100 : 0,
      avgR: sumR / bucket.length,
      avgPnlUsd: sumPnl / bucket.length,
    });
  }

  return { ...core, byRegime, byExitReason };
}

// ── Core Metric Computation ─────────────────────────────────

function computeCoreMetrics(
  trades: TradeLog[],
  startingEquity: number,
  backtestDays: number,
  isRegimeBucket: boolean,
): CoreMetrics {
  const total = trades.length;
  if (total === 0) return emptyMetrics();

  let wins = 0;
  let losses = 0;
  let sumR = 0;
  let totalPnl = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  let sumHolding = 0;
  let sumWinUsd = 0;
  let sumLossUsd = 0;
  let sumWinR = 0;
  let sumLossR = 0;
  let largestWin = 0;
  let largestLoss = 0;

  // Streaks
  let maxConsecWins = 0;
  let maxConsecLosses = 0;
  let winStreak = 0;
  let lossStreak = 0;

  // Drawdown
  let equity = 0;
  let peak = 0;
  let maxDdPct = 0;
  let maxDdUsd = 0;

  // Sharpe: per-trade returns
  const returns: number[] = [];

  for (const t of trades) {
    sumR += t.rMultipleResult;
    totalPnl += t.pnlUsd;
    sumHolding += t.holdingPeriodMinutes;

    if (t.accountEquityAtEntry > 0) {
      returns.push(t.pnlUsd / t.accountEquityAtEntry);
    }

    if (t.pnlUsd >= 0) {
      wins++;
      grossProfit += t.pnlUsd;
      sumWinUsd += t.pnlUsd;
      sumWinR += t.rMultipleResult;
      if (t.pnlUsd > largestWin) largestWin = t.pnlUsd;
      winStreak++;
      if (winStreak > maxConsecWins) maxConsecWins = winStreak;
      lossStreak = 0;
    } else {
      losses++;
      grossLoss += Math.abs(t.pnlUsd);
      sumLossUsd += Math.abs(t.pnlUsd);
      sumLossR += Math.abs(t.rMultipleResult);
      if (t.pnlUsd < largestLoss) largestLoss = t.pnlUsd;
      lossStreak++;
      if (lossStreak > maxConsecLosses) maxConsecLosses = lossStreak;
      winStreak = 0;
    }

    // Drawdown tracking
    equity += t.pnlUsd;
    if (equity > peak) peak = equity;
    if (peak > 0) {
      const ddPct = ((peak - equity) / peak) * 100;
      const ddUsd = peak - equity;
      if (ddPct > maxDdPct) maxDdPct = ddPct;
      if (ddUsd > maxDdUsd) maxDdUsd = ddUsd;
    }
  }

  // Derived
  const winRate = (wins / total) * 100;
  const avgWinUsd = wins > 0 ? sumWinUsd / wins : 0;
  const avgLossUsd = losses > 0 ? sumLossUsd / losses : 0;
  const expectancy =
    (winRate / 100) * avgWinUsd - ((100 - winRate) / 100) * avgLossUsd;

  // Sharpe ratio
  let sharpeRatio: number | null = null;
  if (returns.length >= 2 && backtestDays > 0) {
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance =
      returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length;
    const std = Math.sqrt(variance);
    if (std > 0) {
      const tradesPerYear = total / (backtestDays / 365);
      sharpeRatio = (mean / std) * Math.sqrt(tradesPerYear);
    }
  }

  // Recovery factor
  const recoveryFactor =
    maxDdUsd > 0
      ? totalPnl / maxDdUsd
      : totalPnl > 0
        ? Infinity
        : 0;

  return {
    totalTrades: total,
    wins,
    losses,
    winRate,
    expectancy,
    sharpeRatio,
    maxDrawdownPct: maxDdPct,
    maxDrawdownUsd: maxDdUsd,
    profitFactor:
      grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
    avgRPerTrade: sumR / total,
    totalPnlUsd: totalPnl,
    totalPnlPct: startingEquity > 0 ? (totalPnl / startingEquity) * 100 : 0,
    avgWinUsd,
    avgLossUsd,
    avgWinR: wins > 0 ? sumWinR / wins : 0,
    avgLossR: losses > 0 ? sumLossR / losses : 0,
    largestWinUsd: largestWin,
    largestLossUsd: largestLoss,
    avgHoldingMinutes: Math.round(sumHolding / total),
    maxConsecutiveWins: maxConsecWins,
    maxConsecutiveLosses: maxConsecLosses,
    recoveryFactor,
    sampleFlag: classifySample(total, isRegimeBucket),
  };
}

// ── Sample Classification ───────────────────────────────────

function classifySample(
  count: number,
  isRegimeBucket: boolean,
): "OK" | "LOW_SAMPLE" | "LOW_CONFIDENCE" {
  if (isRegimeBucket) {
    return count < SAMPLE_THRESHOLDS.MIN_TRADES_PER_REGIME
      ? "LOW_SAMPLE"
      : "OK";
  }
  if (count < SAMPLE_THRESHOLDS.HARD_MIN_TRADES) return "LOW_SAMPLE";
  if (count < SAMPLE_THRESHOLDS.SOFT_MIN_TRADES) return "LOW_CONFIDENCE";
  return "OK";
}

// ── Empty Metrics ───────────────────────────────────────────

function emptyMetrics(): CoreMetrics {
  return {
    totalTrades: 0,
    wins: 0,
    losses: 0,
    winRate: 0,
    expectancy: 0,
    sharpeRatio: null,
    maxDrawdownPct: 0,
    maxDrawdownUsd: 0,
    profitFactor: 0,
    avgRPerTrade: 0,
    totalPnlUsd: 0,
    totalPnlPct: 0,
    avgWinUsd: 0,
    avgLossUsd: 0,
    avgWinR: 0,
    avgLossR: 0,
    largestWinUsd: 0,
    largestLossUsd: 0,
    avgHoldingMinutes: 0,
    maxConsecutiveWins: 0,
    maxConsecutiveLosses: 0,
    recoveryFactor: 0,
    sampleFlag: "LOW_SAMPLE",
  };
}
