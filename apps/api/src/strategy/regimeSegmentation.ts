import type { TradeLog, Regime } from "./types.js";
import type {
  SegmentMetrics,
  RegimeSegmentationReport,
} from "./backtestTypes.js";
import { SAMPLE_THRESHOLDS } from "./backtestTypes.js";

// ── Build segment metrics from a trade subset ───────────────

function buildSegmentMetrics(
  segmentName: string,
  trades: TradeLog[],
  totalPnlAll: number,
): SegmentMetrics {
  const n = trades.length;
  if (n === 0) {
    return {
      segmentName,
      tradeCount: 0,
      winRate: 0,
      expectancy: 0,
      profitFactor: 0,
      sharpeRatio: null,
      maxDrawdownPct: 0,
      avgHoldingMinutes: 0,
      bestTradeR: 0,
      worstTradeR: 0,
      recoveryFactor: 0,
      totalPnlUsd: 0,
      pnlPctOfTotal: 0,
    };
  }

  const wins = trades.filter((t) => t.pnlUsd >= 0).length;
  const winRate = (wins / n) * 100;

  const grossProfit = trades
    .filter((t) => t.pnlUsd >= 0)
    .reduce((s, t) => s + t.pnlUsd, 0);
  const grossLoss = trades
    .filter((t) => t.pnlUsd < 0)
    .reduce((s, t) => s + Math.abs(t.pnlUsd), 0);
  const profitFactor =
    grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

  const totalPnl = trades.reduce((s, t) => s + t.pnlUsd, 0);
  const expectancy = totalPnl / n;

  // Sharpe (per-trade)
  let sharpeRatio: number | null = null;
  const returns = trades
    .filter((t) => t.accountEquityAtEntry > 0)
    .map((t) => t.pnlUsd / t.accountEquityAtEntry);
  if (returns.length >= 2) {
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance =
      returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length;
    const std = Math.sqrt(variance);
    if (std > 0) {
      sharpeRatio = (mean / std) * Math.sqrt(252);
    }
  }

  // Drawdown
  let equity = 0;
  let peak = 0;
  let maxDdPct = 0;
  for (const t of trades) {
    equity += t.pnlUsd;
    if (equity > peak) peak = equity;
    if (peak > 0) {
      const dd = ((peak - equity) / peak) * 100;
      if (dd > maxDdPct) maxDdPct = dd;
    }
  }

  const avgHolding =
    Math.round(trades.reduce((s, t) => s + t.holdingPeriodMinutes, 0) / n);
  const bestR = Math.max(...trades.map((t) => t.rMultipleResult));
  const worstR = Math.min(...trades.map((t) => t.rMultipleResult));
  const maxDdUsd = peak > 0 ? peak - Math.min(equity, ...trades.map(() => 0)) : 0;
  const recoveryFactor =
    maxDdPct > 0 && peak > 0
      ? totalPnl / (peak * (maxDdPct / 100))
      : totalPnl > 0
        ? Infinity
        : 0;

  return {
    segmentName,
    tradeCount: n,
    winRate,
    expectancy,
    profitFactor,
    sharpeRatio,
    maxDrawdownPct: maxDdPct,
    avgHoldingMinutes: avgHolding,
    bestTradeR: bestR,
    worstTradeR: worstR,
    recoveryFactor,
    totalPnlUsd: totalPnl,
    pnlPctOfTotal: totalPnlAll !== 0 ? (totalPnl / totalPnlAll) * 100 : 0,
  };
}

// ── Run Regime Segmentation ─────────────────────────────────

export function runRegimeSegmentation(
  trades: TradeLog[],
): RegimeSegmentationReport {
  const totalPnl = trades.reduce((s, t) => s + t.pnlUsd, 0);
  const segments: SegmentMetrics[] = [];
  const flags: string[] = [];

  // ── Regime segments ───────────────────────────────────────
  const regimes: Regime[] = ["TREND_UP", "TREND_DOWN", "RANGE"];
  const regimeSegments: Map<Regime, SegmentMetrics> = new Map();

  for (const regime of regimes) {
    const bucket = trades.filter((t) => t.regime === regime);
    const seg = buildSegmentMetrics(regime, bucket, totalPnl);
    segments.push(seg);
    regimeSegments.set(regime, seg);
  }

  // ── Volatility segments (split on median ATR_14_4H) ───────
  const atrs = trades.map((t) => t.atr14_15mAtEntry).sort((a, b) => a - b);
  const medianAtr =
    atrs.length > 0 ? atrs[Math.floor(atrs.length / 2)] : 0;

  const highVol = trades.filter((t) => t.atr14_15mAtEntry > medianAtr);
  const lowVol = trades.filter((t) => t.atr14_15mAtEntry <= medianAtr);
  const highVolSeg = buildSegmentMetrics("HIGH_VOLATILITY", highVol, totalPnl);
  const lowVolSeg = buildSegmentMetrics("LOW_VOLATILITY", lowVol, totalPnl);
  segments.push(highVolSeg, lowVolSeg);

  // ── Trend strength segments ───────────────────────────────
  const strongTrend = trades.filter((t) => t.adx14_4hAtEntry >= 30);
  const weakTrend = trades.filter(
    (t) => t.adx14_4hAtEntry >= 20 && t.adx14_4hAtEntry < 25,
  );
  segments.push(
    buildSegmentMetrics("STRONG_TREND", strongTrend, totalPnl),
    buildSegmentMetrics("WEAK_TREND", weakTrend, totalPnl),
  );

  // ── Regime consistency check ──────────────────────────────
  const minRegimeTrades = SAMPLE_THRESHOLDS.MIN_TRADES_PER_REGIME;
  const trendUpSeg = regimeSegments.get("TREND_UP")!;
  const trendDownSeg = regimeSegments.get("TREND_DOWN")!;
  const rangeSeg = regimeSegments.get("RANGE")!;

  const trendUpPass =
    trendUpSeg.tradeCount < minRegimeTrades ||
    trendUpSeg.profitFactor >= 1.2;
  const trendDownPass =
    trendDownSeg.tradeCount < minRegimeTrades ||
    trendDownSeg.profitFactor >= 1.2;
  const rangePass =
    rangeSeg.tradeCount < minRegimeTrades || rangeSeg.profitFactor >= 1.0;

  const regimeConsistencyPassed = trendUpPass && trendDownPass && rangePass;
  if (!regimeConsistencyPassed) flags.push("REGIME_CONSISTENCY_FAIL");

  // ── Regime concentration check ────────────────────────────
  const maxPnlPct = Math.max(
    Math.abs(trendUpSeg.pnlPctOfTotal),
    Math.abs(trendDownSeg.pnlPctOfTotal),
    Math.abs(rangeSeg.pnlPctOfTotal),
  );
  const regimeConcentrationPassed = maxPnlPct <= 80;
  if (!regimeConcentrationPassed) flags.push("REGIME_CONCENTRATION_RISK");

  // ── Volatility stability check ────────────────────────────
  const volatilityStabilityPassed =
    highVolSeg.tradeCount < minRegimeTrades ||
    lowVolSeg.tradeCount < minRegimeTrades ||
    highVolSeg.maxDrawdownPct <= 1.5 * lowVolSeg.maxDrawdownPct ||
    lowVolSeg.maxDrawdownPct === 0;
  if (!volatilityStabilityPassed) flags.push("VOLATILITY_INSTABILITY");

  return {
    segments,
    regimeConsistencyPassed,
    regimeConcentrationPassed,
    volatilityStabilityPassed,
    flags,
  };
}
