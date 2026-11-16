/**
 * Bar-by-bar backtest of the Swing Agent's decisions. The rules are injected
 * (`decide`), so this file is only the fill model and the account:
 *
 * - The rules run at each 4h CLOSE with the account marked at that close.
 * - An entry fills at the NEXT 4h bar's open (the live agent orders seconds
 *   after the close), plus slippage, plus the taker fee. It's skipped if that
 *   open is more than 0.25R from the decision close (the live drift guard).
 *   Stop and target prices are the plan's; the size is the plan's.
 * - Stop/target are walked on the four 1h bars inside each 4h bar (the 4h bar
 *   itself when its 1h bars are missing). Per bar: an open beyond the stop or
 *   target fills at that open; otherwise a low/high through the stop fills at
 *   the stop, through the target at the target; both in one bar → the stop.
 *   Fills are STOP_MARKET / TAKE_PROFIT_MARKET: slippage against the trade.
 * - EXIT_TIME (v1 time stop) and EXIT_TREND (v2 EMA 50 close) close at the
 *   next 4h open. A plan without a target (v2) exits only on its stop or that
 *   signal. A position open at the end (the last bar, or `endIndex`) closes
 *   at that bar's close ("end_of_data").
 * - requestHalt kills the agent for the rest of the run (no admin re-arm).
 *
 * Nothing here reads a bar before it happens: bar k's 1h bars are walked
 * before the decision at k's close, and fills use the next bar's open.
 */
import type { Candle } from "../../../indicators/shared";
import type {
  SwingAccount, SwingCosts, SwingPosition, SwingSide, SwingStopSource, SwingTargetSource,
} from "../evaluateSwing";
import { SWING_PARAMS as P } from "../swingParams";

const H1 = 3_600;
const H4 = P.timeframeSec;
/** Max distance of the fill from the decision close, in R (the live drift guard). */
export const DRIFT_GUARD_R = 0.25;

export type ExitReason = "stop" | "target" | "time" | "trend" | "end_of_data";

/** What the fill model needs from an entry plan (v1's SwingPlan and v2's plan both fit). */
export interface SimPlan {
  side: SwingSide;
  entryRef: number;
  stop: number;
  stopSource: SwingStopSource;
  r: number;
  /** null = no fixed target. */
  target: number | null;
  targetSource: SwingTargetSource | null;
  qty: number;
}

/** What the fill model needs from a decision (v1's SwingDecision and v2's both fit). */
export interface SimDecision {
  barTime: number;
  action: "ENTER_LONG" | "ENTER_SHORT" | "EXIT_TIME" | "EXIT_TREND" | "HOLD" | "NO_TRADE";
  candidateSide: SwingSide | null;
  reasonCode: string;
  requestHalt: boolean;
  plan: SimPlan | null;
  inputs: { adx: number | null };
}

export interface SimTrade {
  side: SwingSide;
  /** The signal bar's close. */
  decisionTime: number;
  entryTime: number;
  entryPrice: number;
  qty: number;
  stop: number;
  target: number | null;
  /** The plan's stop distance at the decision close. */
  plannedR: number;
  /** qty × |entry fill − stop|: what one R costs at the actual fill. */
  riskUsd: number;
  exitTime: number;
  exitPrice: number;
  exitReason: ExitReason;
  feesUsd: number;
  /** Net of fees and slippage. */
  pnlUsd: number;
  rMultiple: number;
  /** 4h bars the position was held in, entry bar included. */
  barsHeld: number;
  stopSource: SwingStopSource;
  targetSource: SwingTargetSource | null;
  /** 4h ADX at the decision. */
  adx: number | null;
}

export interface SimResult {
  trades: SimTrade[];
  /** Marked at each 4h close from startIndex. */
  equity: Array<{ time: number; equity: number }>;
  barsTotal: number;
  barsInMarket: number;
  skippedDrift: number;
  fallbackBars: number;
  haltedAt: number | null;
  reasonCounts: Record<string, number>;
  /** Every decision, in order: the 4h bar it read (barTime), what it did and why, for which side. */
  decisions: Array<{ time: number; barTime: number; action: SimDecision["action"]; reasonCode: string; side: SwingSide | null }>;
}

export interface SimInput {
  h4: Candle[];
  h1: Candle[];
  decide: (k: number, account: SwingAccount) => SimDecision;
  costs: SwingCosts;
  startIndex: number;
  /** Exclusive; default h4.length. Bars from here on are never read. */
  endIndex?: number;
  startEquity: number;
}

interface Open {
  pos: SwingPosition;
  entryIndex: number;
  decisionTime: number;
  plannedR: number;
  entryFee: number;
  stopSource: SwingStopSource;
  targetSource: SwingTargetSource | null;
  adx: number | null;
}

export function simulate(input: SimInput): SimResult {
  const { h4, costs, startIndex } = input;
  const endIndex = Math.min(input.endIndex ?? h4.length, h4.length);
  const slip = costs.slippageBps / 10_000;
  const fee = costs.takerFeeBps / 10_000;
  const h1ByTime = new Map(input.h1.map((c) => [c.time, c]));

  const result: SimResult = {
    trades: [], equity: [], barsTotal: 0, barsInMarket: 0, skippedDrift: 0, fallbackBars: 0, haltedAt: null, reasonCounts: {}, decisions: [],
  };
  let cash = input.startEquity;
  let open: Open | null = null;
  let pending: SimDecision | null = null;
  let pendingTime = 0;
  let pendingExit: ExitReason | null = null;
  let killed = false;
  let peak = input.startEquity;
  let day = -1;
  let dayStart = input.startEquity;
  let entriesToday = 0;
  let lastExitTime: number | null = null;

  const dir = (side: SwingSide) => (side === "long" ? 1 : -1);
  const mark = (price: number) => (open ? cash + dir(open.pos.side) * open.pos.qty * price : cash);

  /** Close the open position at a raw price (slippage and fee applied here). */
  const close = (raw: number, time: number, reason: ExitReason, barIndex: number) => {
    const o = open!;
    const d = dir(o.pos.side);
    const px = raw * (1 - d * slip);
    const exitFee = o.pos.qty * px * fee;
    cash += d * o.pos.qty * px - exitFee;
    const risk = o.pos.qty * Math.abs(o.pos.entryPrice - o.pos.stop);
    const pnl = d * o.pos.qty * (px - o.pos.entryPrice) - o.entryFee - exitFee;
    result.trades.push({
      side: o.pos.side,
      decisionTime: o.decisionTime,
      entryTime: o.pos.entryBarTime,
      entryPrice: o.pos.entryPrice,
      qty: o.pos.qty,
      stop: o.pos.stop,
      target: o.pos.target,
      plannedR: o.plannedR,
      riskUsd: risk,
      exitTime: time,
      exitPrice: px,
      exitReason: reason,
      feesUsd: o.entryFee + exitFee,
      pnlUsd: pnl,
      rMultiple: risk > 0 ? pnl / risk : 0,
      barsHeld: barIndex - o.entryIndex + 1,
      stopSource: o.stopSource,
      targetSource: o.targetSource,
      adx: o.adx,
    });
    open = null;
    lastExitTime = time;
  };

  for (let k = startIndex; k < endIndex; k++) {
    const bar = h4[k]!;
    const closeTime = bar.time + H4;
    result.barsTotal++;

    // ── at the open: a time/trend exit or an entry decided at the previous close ──
    if (pendingExit && open) close(bar.open, bar.time, pendingExit, k - 1);
    pendingExit = null;
    if (pending?.plan) {
      const p = pending.plan;
      if (Math.abs(bar.open - p.entryRef) > DRIFT_GUARD_R * p.r + 1e-9) {
        result.skippedDrift++;
      } else {
        const d = dir(p.side);
        const px = bar.open * (1 + d * slip);
        const entryFee = p.qty * px * fee;
        cash -= d * p.qty * px + entryFee;
        open = {
          pos: { side: p.side, entryBarTime: bar.time, qty: p.qty, entryPrice: px, stop: p.stop, target: p.target },
          entryIndex: k,
          decisionTime: pendingTime,
          plannedR: p.r,
          entryFee,
          stopSource: p.stopSource,
          targetSource: p.targetSource,
          adx: pending.inputs.adx,
        };
        const entryDay = Math.floor(bar.time / 86_400);
        if (entryDay !== day) { day = entryDay; dayStart = mark(bar.open); entriesToday = 0; }
        entriesToday++;
      }
    }
    pending = null;

    // ── inside the bar: stop / target on the 1h bars ──
    if (open) {
      result.barsInMarket++;
      let steps: Array<{ c: Candle; sec: number }> = [];
      for (let h = 0; h < 4; h++) {
        const c = h1ByTime.get(bar.time + h * H1);
        if (!c) { steps = []; break; }
        steps.push({ c, sec: H1 });
      }
      if (steps.length === 0) {
        steps = [{ c: bar, sec: H4 }];
        result.fallbackBars++;
      }
      for (const { c, sec } of steps) {
        const o: Open = open;
        const long = o.pos.side === "long";
        const { stop, target } = o.pos;
        if (long ? c.open <= stop : c.open >= stop) { close(c.open, c.time, "stop", k); break; }
        if (target !== null && (long ? c.open >= target : c.open <= target)) { close(c.open, c.time, "target", k); break; }
        if (long ? c.low <= stop : c.high >= stop) { close(stop, c.time + sec, "stop", k); break; }
        if (target !== null && (long ? c.high >= target : c.low <= target)) { close(target, c.time + sec, "target", k); break; }
      }
    }

    // ── at the close: mark, then decide ──
    const equity = mark(bar.close);
    result.equity.push({ time: closeTime, equity });
    peak = Math.max(peak, equity);
    const today = Math.floor(closeTime / 86_400);
    if (today !== day) { day = today; dayStart = equity; entriesToday = 0; }

    const account: SwingAccount = {
      equity,
      peakEquity: peak,
      dayStartEquity: dayStart,
      entriesToday,
      killed,
      position: open ? { ...(open as Open).pos } : null,
      lastExitTime,
    };
    const d = input.decide(k, account);
    result.reasonCounts[d.reasonCode] = (result.reasonCounts[d.reasonCode] ?? 0) + 1;
    result.decisions.push({ time: closeTime, barTime: d.barTime, action: d.action, reasonCode: d.reasonCode, side: d.candidateSide });
    if (d.requestHalt && !killed) { killed = true; result.haltedAt = closeTime; }
    if (d.action === "EXIT_TIME" && open) pendingExit = "time";
    if (d.action === "EXIT_TREND" && open) pendingExit = "trend";
    if ((d.action === "ENTER_LONG" || d.action === "ENTER_SHORT") && !open && d.plan) { pending = d; pendingTime = closeTime; }
  }

  const last = h4[endIndex - 1];
  if (open && last) {
    close(last.close, last.time + H4, "end_of_data", endIndex - 1);
    const e = result.equity[result.equity.length - 1];
    if (e) e.equity = cash;
  }
  return result;
}
