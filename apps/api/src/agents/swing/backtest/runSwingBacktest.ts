/**
 * One Swing Agent backtest run: the live rules (evaluateSwing on
 * snapshotAt) over a candle history, through the fill model (simulate.ts),
 * starting at the first bar where neither variant is in warm-up so both
 * variants and buy-and-hold cover the same window.
 *
 * `adxMin` is the sensitivity line: entries whose 4h ADX is under it become
 * "adx_weak" no-trades. ADX is a pure blocking gate, so this equals running
 * the rules with that threshold.
 */
import { computeADX, htfValueAt, type Candle, type Point } from "../../../indicators/shared";
import { evaluateSwing, type SwingAccount, type SwingCosts, type SwingDecision, type SwingVariant } from "../evaluateSwing";
import { buildSwingSeries, snapshotAt, type SwingCandles, type SwingSeries } from "../swingSeries";
import { simulate, type SimResult, type SimTrade } from "./simulate";

const D1 = 86_400;

export interface BacktestCandles extends SwingCandles {
  /** For walking stops/targets inside each 4h bar; may be empty (falls back to the 4h bar). */
  h1: Candle[];
}

export type Regime = "trending" | "transitional" | "ranging" | "unknown";

export interface BacktestTrade extends SimTrade {
  /** Daily ADX(14) regime at the decision. */
  regime: Regime;
}

/** Daily ADX(14): >= 25 trending, < 20 ranging, in between transitional. */
export function regimeOf(dailyAdx: number | null): Regime {
  if (dailyAdx === null) return "unknown";
  if (dailyAdx >= 25) return "trending";
  if (dailyAdx < 20) return "ranging";
  return "transitional";
}

/** Daily ADX(14) in force at an instant (the last CLOSED daily bar's). */
export function dailyAdxAt(d1: Candle[]): (t: number) => number | null {
  const adx: Point[] = computeADX(d1, { diLength: 14, adxSmoothing: 14 }).adx;
  return (t) => htfValueAt(adx, D1, t);
}

const FLAT: SwingAccount = {
  equity: 100_000, peakEquity: 100_000, dayStartEquity: 100_000, entriesToday: 0, killed: false, position: null, lastExitTime: null,
};

/** First 4h index where neither variant's rules report warm-up. */
export function firstEvaluableIndex(series: SwingSeries): number {
  const costs = { takerFeeBps: 0, slippageBps: 0 };
  for (let k = 0; k < series.candles.h4.length; k++) {
    const s = snapshotAt(series, k);
    if (evaluateSwing(s, FLAT, "A", costs).reasonCode !== "warmup"
      && evaluateSwing(s, FLAT, "B", costs).reasonCode !== "warmup") return k;
  }
  return series.candles.h4.length;
}

function withAdxMin(d: SwingDecision, adxMin: number): SwingDecision {
  const entering = d.action === "ENTER_LONG" || d.action === "ENTER_SHORT";
  if (!entering || (d.inputs.adx !== null && d.inputs.adx >= adxMin)) return d;
  return {
    ...d, action: "NO_TRADE", side: null, plan: null, reasonCode: "adx_weak",
    reason: `No trade: 4h ADX ${d.inputs.adx?.toFixed(2) ?? "—"} is under ${adxMin} (sensitivity run).`,
  };
}

export interface RunInput {
  candles: BacktestCandles;
  variant: SwingVariant;
  costs: SwingCosts;
  startEquity: number;
  adxMin?: number;
  /** Prebuilt series for these candles (saves rebuilding across runs). */
  series?: SwingSeries;
  startIndex?: number;
}

export interface RunOutput {
  startIndex: number;
  sim: SimResult;
  trades: BacktestTrade[];
}

export function runSwingBacktest(input: RunInput): RunOutput {
  const series = input.series ?? buildSwingSeries(input.candles);
  const startIndex = input.startIndex ?? firstEvaluableIndex(series);
  const sim = simulate({
    h4: input.candles.h4,
    h1: input.candles.h1,
    costs: input.costs,
    startIndex,
    startEquity: input.startEquity,
    decide: (k, account) => {
      const d = evaluateSwing(snapshotAt(series, k), account, input.variant, input.costs);
      return input.adxMin === undefined ? d : withAdxMin(d, input.adxMin);
    },
  });
  const adxAt = dailyAdxAt(input.candles.d1);
  return { startIndex, sim, trades: sim.trades.map((t) => ({ ...t, regime: regimeOf(adxAt(t.decisionTime)) })) };
}

/** Share of the tested 4h bars in each regime (by the daily ADX at each close). */
export function regimeShare(candles: BacktestCandles, startIndex: number): Record<Regime, number> {
  const adxAt = dailyAdxAt(candles.d1);
  const out: Record<Regime, number> = { trending: 0, transitional: 0, ranging: 0, unknown: 0 };
  const bars = candles.h4.slice(startIndex);
  for (const c of bars) out[regimeOf(adxAt(c.time + 14_400))]++;
  for (const k of Object.keys(out) as Regime[]) out[k] = bars.length ? out[k] / bars.length : 0;
  return out;
}
