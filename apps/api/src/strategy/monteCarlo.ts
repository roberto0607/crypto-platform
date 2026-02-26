import type { TradeLog } from "./types.js";
import type { MonteCarloConfig, MonteCarloResult } from "./backtestTypes.js";
import { DEFAULT_MC_CONFIG } from "./backtestTypes.js";

// ── Fisher-Yates shuffle (in place) ────────────────────────

function shuffleArray<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ── Percentile helper ───────────────────────────────────────

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

// ── Run Monte Carlo ─────────────────────────────────────────

export function runMonteCarlo(
  trades: TradeLog[],
  config: MonteCarloConfig = DEFAULT_MC_CONFIG,
): MonteCarloResult {
  const { nSims, initialEquity, ruinThreshold } = config;
  const pnls = trades.map((t) => t.pnlUsd);

  if (pnls.length === 0) {
    return {
      nSims,
      probabilityOfRuin: 1,
      medianMaxDrawdownPct: 100,
      p95MaxDrawdownPct: 100,
      p99MaxDrawdownPct: 100,
      medianTerminalEquity: initialEquity,
      p5TerminalEquity: initialEquity,
      p95TerminalEquity: initialEquity,
      maxConsecutiveLossesP95: 0,
      passed: false,
    };
  }

  const terminalEquities: number[] = [];
  const maxDrawdowns: number[] = [];
  const maxConsecLosses: number[] = [];
  let ruinCount = 0;

  for (let s = 0; s < nSims; s++) {
    const shuffled = shuffleArray(pnls);

    let equity = initialEquity;
    let peak = initialEquity;
    let maxDdPct = 0;
    let consecLosses = 0;
    let maxConsec = 0;
    let ruined = false;

    for (const pnl of shuffled) {
      equity += pnl;

      if (equity > peak) peak = equity;
      if (peak > 0) {
        const dd = ((peak - equity) / peak) * 100;
        if (dd > maxDdPct) maxDdPct = dd;
      }

      if (equity < ruinThreshold) ruined = true;

      if (pnl < 0) {
        consecLosses++;
        if (consecLosses > maxConsec) maxConsec = consecLosses;
      } else {
        consecLosses = 0;
      }
    }

    terminalEquities.push(equity);
    maxDrawdowns.push(maxDdPct);
    maxConsecLosses.push(maxConsec);
    if (ruined) ruinCount++;
  }

  // Sort for percentile computation
  terminalEquities.sort((a, b) => a - b);
  maxDrawdowns.sort((a, b) => a - b);
  maxConsecLosses.sort((a, b) => a - b);

  const probabilityOfRuin = ruinCount / nSims;
  const medianMaxDrawdownPct = percentile(maxDrawdowns, 50);
  const p95MaxDrawdownPct = percentile(maxDrawdowns, 95);
  const p99MaxDrawdownPct = percentile(maxDrawdowns, 99);
  const medianTerminalEquity = percentile(terminalEquities, 50);
  const p5TerminalEquity = percentile(terminalEquities, 5);
  const p95TerminalEquity = percentile(terminalEquities, 95);
  const maxConsecutiveLossesP95 = percentile(maxConsecLosses, 95);

  const passed =
    probabilityOfRuin <= 0.05 &&
    p95MaxDrawdownPct <= 25 &&
    p5TerminalEquity > initialEquity &&
    medianTerminalEquity > initialEquity * 1.05;

  return {
    nSims,
    probabilityOfRuin,
    medianMaxDrawdownPct,
    p95MaxDrawdownPct,
    p99MaxDrawdownPct,
    medianTerminalEquity,
    p5TerminalEquity,
    p95TerminalEquity,
    maxConsecutiveLossesP95,
    passed,
  };
}
