/**
 * The scorecard's calls over a window (addendum point 10). At each row's
 * close the scorecard decides; a LONG / SHORT opens the pre-registered
 * position (targets.ts: entry at the next open, stop 1.5 ATR, out at the
 * stop or after 42 bars). One position at a time; the next decision is at
 * the exit bar's close. Rows without a target can't be traded.
 *
 * Account: $100,000, 1% of equity at risk per trade (qty = 1% × equity ÷
 * 1R), notional ≤ 1× equity, base costs, equity marked at each 4h close.
 * MAR = CAGR ÷ max drawdown (swing metrics), the same accounting as Swing
 * v2's baseline (b).
 */
import { marOf, maxDrawdownPct } from "../../swing/backtest/metrics";
import type { StudyData } from "./studyData";
import { decide, type Scorecard } from "./scorecard";
import { holdWindowOk, rOutcome } from "./targets";
import { STUDY_ADDENDUM as A, STUDY_COSTS, STUDY_PREREGISTRATION as S } from "./studyParams";

const H4 = 14_400;
const YEAR_SEC = 365.25 * 86_400;

export interface BacktestTrade {
  k: number;
  side: 1 | -1;
  exitIndex: number;
  r: number;
  rStress: number;
  equityBefore: number;
  pnlUsd: number;
}

export interface BacktestResult {
  calls: number;
  trades: BacktestTrade[];
  avgR: number;
  avgRStress: number;
  cagrPct: number;
  maxDrawdownPct: number;
  mar: number | null;
}

export function runBacktest(card: Scorecard, data: StudyData): BacktestResult {
  const { h4, rows, window } = data;
  const end = window.toExclusive;
  const start = A.backtest.startEquity;
  const slip = STUDY_COSTS.base.slippageBps / 10_000;
  let cash = start;
  let open: { trade: BacktestTrade; qty: number; entryFill: number } | null = null;
  const trades: BacktestTrade[] = [];
  const marks: number[] = [start];
  const byK = new Map(rows.map((r) => [r.k, r]));
  const first = rows[0]?.k ?? 0;
  const last = rows.length ? rows[rows.length - 1]!.k : -1;

  for (let k = first; k <= last; k++) {
    // settle a position that exits at this bar, then mark
    if (open && open.trade.exitIndex === k) {
      cash += open.trade.pnlUsd;
      open = null;
    }
    const bar = h4[k];
    if (!bar) continue;
    marks.push(open ? cash + open.qty * open.trade.side * (bar.close - open.entryFill) : cash);

    const row = byK.get(k);
    if (open || !row || row.atr === null || !holdWindowOk(h4, k, end)) continue;
    const d = decide(card, row.values);
    if (d === "NO_TRADE") continue;
    const side: 1 | -1 = d === "LONG" ? 1 : -1;
    const base = rOutcome(h4, k, row.atr, side, STUDY_COSTS.base)!;
    const stress = rOutcome(h4, k, row.atr, side, STUDY_COSTS.stress)!;
    const unit = S.targets.stopAtr * row.atr;
    const entryFill: number = h4[k + 1]!.open * (1 + side * slip);
    const qty = Math.min((A.backtest.riskPerTrade * cash) / unit, (A.backtest.maxNotionalToEquity * cash) / entryFill);
    const trade: BacktestTrade = { k, side, exitIndex: base.exitIndex, r: base.r, rStress: stress.r, equityBefore: cash, pnlUsd: qty * base.r * unit };
    trades.push(trade);
    open = { trade, qty, entryFill };
  }
  if (open) cash += open.trade.pnlUsd; // closes inside the window by construction (holdWindowOk)

  const span = rows.length ? h4[last]!.time + H4 - h4[first]!.time : 0;
  const cagrPct = span > 0 && cash > 0 ? Math.pow(cash / start, YEAR_SEC / span) - 1 : 0;
  const dd = maxDrawdownPct([...marks, cash]);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
  return {
    calls: trades.length,
    trades,
    avgR: mean(trades.map((t) => t.r)),
    avgRStress: mean(trades.map((t) => t.rStress)),
    cagrPct,
    maxDrawdownPct: dd,
    mar: marOf(cagrPct, dd),
  };
}
