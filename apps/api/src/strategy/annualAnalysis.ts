import type { TradeLog } from "./types.js";
import type { AnnualMetrics, AnnualAnalysisReport } from "./backtestTypes.js";

// ── Run Annual Analysis ─────────────────────────────────────

export function runAnnualAnalysis(
  trades: TradeLog[],
): AnnualAnalysisReport {
  if (trades.length === 0) {
    return {
      years: [],
      profitableYears: 0,
      totalYears: 0,
      worstYearDrawdown: 0,
      bestYearPnlPct: 0,
      passed: false,
      flags: ["NO_TRADES"],
    };
  }

  // Group trades by calendar year of entry
  const byYear = new Map<number, TradeLog[]>();
  for (const t of trades) {
    const year = new Date(t.timestampEntry).getUTCFullYear();
    if (!byYear.has(year)) byYear.set(year, []);
    byYear.get(year)!.push(t);
  }

  const totalPnl = trades.reduce((s, t) => s + t.pnlUsd, 0);
  const years: AnnualMetrics[] = [];

  for (const [year, bucket] of [...byYear.entries()].sort(
    (a, b) => a[0] - b[0],
  )) {
    const n = bucket.length;
    const pnl = bucket.reduce((s, t) => s + t.pnlUsd, 0);
    const wins = bucket.filter((t) => t.pnlUsd >= 0).length;
    const grossProfit = bucket
      .filter((t) => t.pnlUsd >= 0)
      .reduce((s, t) => s + t.pnlUsd, 0);
    const grossLoss = bucket
      .filter((t) => t.pnlUsd < 0)
      .reduce((s, t) => s + Math.abs(t.pnlUsd), 0);
    const profitFactor =
      grossLoss > 0
        ? grossProfit / grossLoss
        : grossProfit > 0
          ? Infinity
          : 0;

    // Drawdown for this year
    let equity = 0;
    let peak = 0;
    let maxDdPct = 0;
    for (const t of bucket) {
      equity += t.pnlUsd;
      if (equity > peak) peak = equity;
      if (peak > 0) {
        const dd = ((peak - equity) / peak) * 100;
        if (dd > maxDdPct) maxDdPct = dd;
      }
    }

    years.push({
      year,
      tradeCount: n,
      totalPnlUsd: pnl,
      profitFactor,
      maxDrawdownPct: maxDdPct,
      winRate: n > 0 ? (wins / n) * 100 : 0,
      expectancy: n > 0 ? pnl / n : 0,
      pnlPctOfTotal: totalPnl !== 0 ? (pnl / totalPnl) * 100 : 0,
    });
  }

  const profitableYears = years.filter((y) => y.totalPnlUsd > 0).length;
  const totalYears = years.length;
  const worstYearDrawdown = Math.max(...years.map((y) => y.maxDrawdownPct), 0);
  const bestYearPnlPct = Math.max(
    ...years.map((y) => Math.abs(y.pnlPctOfTotal)),
    0,
  );

  const flags: string[] = [];

  // Must be profitable in at least 2 of 3 years
  const minProfitableYears = totalYears >= 3 ? 2 : totalYears;
  if (profitableYears < minProfitableYears) flags.push("INSUFFICIENT_YEARLY_PROFIT");

  // Worst year drawdown <= 30%
  if (worstYearDrawdown > 30) flags.push("ANNUAL_DRAWDOWN_EXCESSIVE");

  // No single year > 70% of total PnL
  if (bestYearPnlPct > 70) flags.push("SINGLE_YEAR_DOMINANCE");

  // Each profitable year must have PF >= 1.10
  for (const y of years) {
    if (y.totalPnlUsd > 0 && isFinite(y.profitFactor) && y.profitFactor < 1.1) {
      flags.push(`WEAK_YEAR_${y.year}`);
    }
  }

  const passed =
    profitableYears >= minProfitableYears &&
    worstYearDrawdown <= 30 &&
    bestYearPnlPct <= 70;

  return {
    years,
    profitableYears,
    totalYears,
    worstYearDrawdown,
    bestYearPnlPct,
    passed,
    flags,
  };
}
