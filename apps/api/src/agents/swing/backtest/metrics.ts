/** Backtest statistics. Fractions everywhere (0.25 = 25%); the report formats them. */
import type { Candle } from "../../../indicators/shared";
import type { SwingCosts } from "../evaluateSwing";
import type { SimResult, SimTrade } from "./simulate";

/** Results on fewer trades than this are flagged low-confidence. */
export const LOW_CONFIDENCE_TRADES = 30;
const YEAR_SEC = 365.25 * 86_400;

export interface TradeStats {
  trades: number;
  wins: number;
  winRate: number;
  avgR: number;
  /** Mean net P&L per trade, USD. */
  expectancyUsd: number;
  netPnlUsd: number;
  /** Gross net wins ÷ gross net losses; null when there is no loss. */
  profitFactor: number | null;
  longestLosingStreak: number;
  lowConfidence: boolean;
}

export interface RunStats extends TradeStats {
  returnPct: number;
  cagrPct: number;
  maxDrawdownPct: number;
  timeInMarketPct: number;
}

export function tradeStats(trades: Pick<SimTrade, "pnlUsd" | "rMultiple">[]): TradeStats {
  const n = trades.length;
  let wins = 0, grossWin = 0, grossLoss = 0, sumR = 0, streak = 0, longest = 0;
  for (const t of trades) {
    sumR += t.rMultiple;
    if (t.pnlUsd > 0) { wins++; grossWin += t.pnlUsd; streak = 0; } else { grossLoss -= t.pnlUsd; streak++; longest = Math.max(longest, streak); }
  }
  const net = grossWin - grossLoss;
  return {
    trades: n,
    wins,
    winRate: n ? wins / n : 0,
    avgR: n ? sumR / n : 0,
    expectancyUsd: n ? net / n : 0,
    netPnlUsd: net,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
    longestLosingStreak: longest,
    lowConfidence: n < LOW_CONFIDENCE_TRADES,
  };
}

export function maxDrawdownPct(values: number[]): number {
  let peak = -Infinity;
  let worst = 0;
  for (const v of values) {
    peak = Math.max(peak, v);
    if (peak > 0) worst = Math.max(worst, 1 - v / peak);
  }
  return worst;
}

function cagr(start: number, end: number, seconds: number): number {
  if (start <= 0 || end <= 0 || seconds <= 0) return 0;
  return Math.pow(end / start, YEAR_SEC / seconds) - 1;
}

export function summarize(sim: SimResult, startEquity: number): RunStats {
  const first = sim.equity[0];
  const last = sim.equity[sim.equity.length - 1];
  const end = last?.equity ?? startEquity;
  return {
    ...tradeStats(sim.trades),
    returnPct: end / startEquity - 1,
    cagrPct: first && last ? cagr(startEquity, end, last.time - first.time) : 0,
    maxDrawdownPct: maxDrawdownPct([startEquity, ...sim.equity.map((e) => e.equity)]),
    timeInMarketPct: sim.barsTotal ? sim.barsInMarket / sim.barsTotal : 0,
  };
}

/**
 * Buy at bar `startIndex`'s open, sell at the last close, with slippage and
 * the taker fee on both legs; drawdown on the position marked at each close.
 */
export function buyAndHold(
  h4: Candle[], startIndex: number, costs: SwingCosts, startEquity: number,
): { returnPct: number; cagrPct: number; maxDrawdownPct: number } {
  const slip = costs.slippageBps / 10_000;
  const fee = costs.takerFeeBps / 10_000;
  const first = h4[startIndex];
  const last = h4[h4.length - 1];
  if (!first || !last) return { returnPct: 0, cagrPct: 0, maxDrawdownPct: 0 };
  const qty = startEquity / (first.open * (1 + slip) * (1 + fee));
  const end = qty * last.close * (1 - slip) * (1 - fee);
  const marks = h4.slice(startIndex).map((c) => qty * c.close);
  return {
    returnPct: end / startEquity - 1,
    cagrPct: cagr(startEquity, end, last.time + 14_400 - first.time),
    maxDrawdownPct: maxDrawdownPct(marks),
  };
}
