/**
 * The two baselines every v2 report carries (numbers: SWING_BASELINES):
 *
 * (a) "weekly trend, full size": long 100% of equity while the last closed
 *     weekly close > SMA 50w, else flat.
 * (b) "weekly trend, 1% risk": the same signal, sized to lose 1% of equity at
 *     a fixed stop = the weekly close − 2 × weekly ATR(14), capped at 1x
 *     notional. Exits on that stop (walked on 1h bars) or the weekly signal.
 *     After a stop-out it re-enters at the next weekly close still above.
 *
 * Both are long only, use the same costs and the same fills as the agent: a
 * decision at a 4h close (a weekly close is a Monday 00:00 UTC 4h boundary)
 * fills at the next 4h open ± slippage + taker fee. At the period's first bar
 * the signal in force from the last closed week is acted on at that bar's
 * open. A position open at the period end closes at its last close. No daily
 * or drawdown limits.
 */
import { computePineATR, computeSMA, htfValueAt, type Candle, type Point } from "../../../indicators/shared";
import type { SwingCosts } from "../evaluateSwing";
import { SWING_BASELINES as B } from "../swingParamsV2";

const H1 = 3_600;
const H4 = 14_400;
const W1 = 604_800;

export type BaselineKind = "a" | "b";
export type BaselineExit = "stop" | "signal" | "end_of_data";

export interface BaselineTrade {
  side: "long";
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  qty: number;
  /** (b) only; null for (a). */
  stop: number | null;
  exitReason: BaselineExit;
  feesUsd: number;
  pnlUsd: number;
  /** pnl ÷ (qty × |entry − stop|) for (b); pnl ÷ 1% of entry equity for (a), so (a)'s R is "per 1% of equity". */
  rMultiple: number;
}

export interface BaselineResult {
  trades: BaselineTrade[];
  equity: Array<{ time: number; equity: number }>;
  barsTotal: number;
  barsInMarket: number;
}

export interface BaselineInput {
  kind: BaselineKind;
  h4: Candle[];
  h1: Candle[];
  w1: Candle[];
  costs: SwingCosts;
  startIndex: number;
  /** Exclusive. */
  endIndex: number;
  startEquity: number;
}

export function runBaseline(input: BaselineInput): BaselineResult {
  const { h4, w1, costs, kind } = input;
  const slip = costs.slippageBps / 10_000;
  const fee = costs.takerFeeBps / 10_000;
  const h1ByTime = new Map(input.h1.map((c) => [c.time, c]));
  const wClose: Point[] = w1.map((c) => ({ time: c.time, value: c.close }));
  const wSma: Point[] = computeSMA(w1, B.weeklySma);
  const wAtr: Point[] = computePineATR(w1, B.atrPeriod);
  const endIndex = Math.min(input.endIndex, h4.length);

  /** The weekly signal in force at instant t (last CLOSED week): long?, the close, the stop. */
  const signalAt = (t: number) => {
    const close = htfValueAt(wClose, W1, t);
    const sma = htfValueAt(wSma, W1, t);
    const atr = htfValueAt(wAtr, W1, t);
    if (close === null || sma === null) return null;
    return { long: close > sma, close, stop: atr === null ? null : close - B.stopAtrMult * atr };
  };

  const out: BaselineResult = { trades: [], equity: [], barsTotal: 0, barsInMarket: 0 };
  let cash = input.startEquity;
  let pos: { qty: number; entry: number; entryTime: number; stop: number | null; entryFee: number; riskUsd: number } | null = null;
  let pending: { action: "enter" | "exit"; ref: number; stop: number | null } | null = null;

  const mark = (p: number) => (pos ? cash + pos.qty * p : cash);
  const close = (raw: number, time: number, reason: BaselineExit) => {
    const p = pos!;
    const px = raw * (1 - slip);
    const exitFee = p.qty * px * fee;
    cash += p.qty * px - exitFee;
    const pnl = p.qty * (px - p.entry) - p.entryFee - exitFee;
    out.trades.push({
      side: "long", entryTime: p.entryTime, exitTime: time, entryPrice: p.entry, exitPrice: px, qty: p.qty, stop: p.stop,
      exitReason: reason, feesUsd: p.entryFee + exitFee, pnlUsd: pnl, rMultiple: p.riskUsd > 0 ? pnl / p.riskUsd : 0,
    });
    pos = null;
  };
  const enter = (bar: Candle, ref: number, stop: number | null) => {
    const equity = cash;
    const px = bar.open * (1 + slip);
    let qty: number;
    let riskUsd: number;
    if (kind === "a") {
      qty = equity / (px * (1 + fee));
      riskUsd = equity * B.riskPerTrade;
    } else {
      if (stop === null || stop >= ref) return;
      const costPerUnit = (ref * 2 * (costs.takerFeeBps + costs.slippageBps)) / 10_000;
      const qtyRisk = (equity * B.riskPerTrade) / (ref - stop + costPerUnit);
      const qtyCap = (equity * B.maxNotionalOfEquity) / (px * (1 + fee));
      qty = Math.floor(Math.min(qtyRisk, qtyCap) * 1e8) / 1e8;
      if (qty <= 0) return;
      riskUsd = qty * Math.abs(px - stop);
    }
    const entryFee = qty * px * fee;
    cash -= qty * px + entryFee;
    pos = { qty, entry: px, entryTime: bar.time, stop: kind === "b" ? stop : null, entryFee, riskUsd };
  };

  for (let k = input.startIndex; k < endIndex; k++) {
    const bar = h4[k]!;
    const closeTime = bar.time + H4;
    out.barsTotal++;

    // ── the period's first bar: act on the signal already in force ──
    if (k === input.startIndex) {
      const sig = signalAt(bar.time);
      if (sig?.long) pending = { action: "enter", ref: sig.close, stop: sig.stop };
    }
    // ── at the open ──
    if (pending) {
      if (pending.action === "exit" && pos) close(bar.open, bar.time, "signal");
      else if (pending.action === "enter" && !pos) enter(bar, pending.ref, pending.stop);
      pending = null;
    }
    // ── inside the bar: (b)'s stop on the 1h bars ──
    if (pos) {
      out.barsInMarket++;
      const p = pos as { stop: number | null };
      if (p.stop !== null) {
        const stop = p.stop;
        let steps: Array<{ c: Candle; sec: number }> = [];
        for (let h = 0; h < 4; h++) {
          const c = h1ByTime.get(bar.time + h * H1);
          if (!c) { steps = []; break; }
          steps.push({ c, sec: H1 });
        }
        if (steps.length === 0) steps = [{ c: bar, sec: H4 }];
        for (const { c, sec } of steps) {
          if (c.open <= stop) { close(c.open, c.time, "stop"); break; }
          if (c.low <= stop) { close(stop, c.time + sec, "stop"); break; }
        }
      }
    }
    // ── at the close ──
    out.equity.push({ time: closeTime, equity: mark(bar.close) });
    if (closeTime % W1 === 345_600 /* Monday 00:00 UTC: epoch 0 was a Thursday */) {
      const sig = signalAt(closeTime);
      if (sig) {
        if (sig.long && !pos) pending = { action: "enter", ref: sig.close, stop: sig.stop };
        else if (!sig.long && pos) pending = { action: "exit", ref: sig.close, stop: null };
      }
    }
  }

  const last = h4[endIndex - 1];
  if (pos && last) {
    close(last.close, last.time + H4, "end_of_data");
    const e = out.equity[out.equity.length - 1];
    if (e) e.equity = cash;
  }
  return out;
}
