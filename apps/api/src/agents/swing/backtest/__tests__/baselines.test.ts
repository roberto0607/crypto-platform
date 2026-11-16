/**
 * The two baselines on hand-built candles: weekly SMA 50 signal acted on at
 * the next 4h open (or at the period's first open), (a) full size, (b) 1%
 * risk with a fixed 2 × weekly ATR(14) stop walked on 1h bars, re-entry at
 * the next weekly close still above, end-of-period close.
 */
import { describe, it, expect } from "vitest";
import { computePineATR, computeSMA, type Candle } from "../../../../indicators/shared";
import { runBaseline } from "../baselines";

const H1 = 3_600;
const H4 = 14_400;
const W1 = 604_800;
const W0 = Date.UTC(2024, 0, 1) / 1000; // Monday 00:00 UTC
const COSTS = { takerFeeBps: 5, slippageBps: 5 };
const s = 0.0005;
const f = 0.0005;

/** 55 flat weeks at 100 (high 105, low 95), then the given closes. */
function weeks(extra: number[]): Candle[] {
  const closes = [...Array(55).fill(100), ...extra];
  return closes.map((c, i) => ({ time: W0 + i * W1, open: c, high: c + 5, low: c - 5, close: c, volume: 1 }));
}

/** 4h + 1h bars at a flat price for weeks [from, to) of the weekly series; `h1Over` by 1h open time. */
function intraday(from: number, to: number, price: number, h1Over: Record<number, Partial<Candle>> = {}) {
  const h4: Candle[] = [];
  const h1: Candle[] = [];
  for (let t = W0 + from * W1; t < W0 + to * W1; t += H4) {
    const hours: Candle[] = [];
    for (let h = 0; h < 4; h++) {
      const ht = t + h * H1;
      hours.push({ time: ht, open: price, high: price + 1, low: price - 1, close: price, volume: 1, ...h1Over[ht] });
    }
    h1.push(...hours);
    h4.push({
      time: t, open: hours[0]!.open, high: Math.max(...hours.map((c) => c.high)), low: Math.min(...hours.map((c) => c.low)),
      close: hours[3]!.close, volume: 4,
    });
  }
  return { h4, h1 };
}

const value = (pts: { time: number; value: number }[], t: number) => pts.find((p) => p.time === t)!.value;

describe("baselines", () => {
  // Week 55 closes 120 (above SMA 50), week 56 closes 80 (below), week 57 closes 130 (above).
  const w1 = weeks([120, 80, 130]);

  it("(a) enters at the period's first open on the signal in force, exits at the 4h open after a weekly close below", () => {
    const { h4, h1 } = intraday(56, 59, 110);
    const r = runBaseline({ kind: "a", h4, h1, w1, costs: COSTS, startIndex: 0, endIndex: h4.length, startEquity: 100_000 });
    const [t1, t2] = r.trades;
    expect(t1!.entryTime).toBe(W0 + 56 * W1);
    expect(t1!.entryPrice).toBeCloseTo(110 * (1 + s), 12);
    expect(t1!.qty).toBeCloseTo(100_000 / (110 * (1 + s) * (1 + f)), 8);
    expect(t1!.exitReason).toBe("signal");
    expect(t1!.exitTime).toBe(W0 + 57 * W1); // week 56 closed below at 57's open
    expect(t1!.stop).toBeNull();
    // Week 57 closes above again: re-enter at week 58's open, held to the end.
    expect(t2!.entryTime).toBe(W0 + 58 * W1);
    expect(t2!.exitReason).toBe("end_of_data");
    expect(r.barsInMarket).toBe(2 * 42);
  });

  it("(b) sizes to 1% risk at 2 × weekly ATR(14) below the weekly close, and the stop exits on the 1h bar", () => {
    const atr55 = value(computePineATR(w1, 14), W0 + 55 * W1);
    const stop = 120 - 2 * atr55;
    const hit = W0 + 56 * W1 + 10 * H4 + 2 * H1;
    const { h4, h1 } = intraday(56, 57, 110, { [hit]: { low: stop - 1 } });
    const r = runBaseline({ kind: "b", h4, h1, w1, costs: COSTS, startIndex: 0, endIndex: h4.length, startEquity: 100_000 });
    const t = r.trades[0]!;
    expect(t.stop).toBeCloseTo(stop, 10);
    const costPerUnit = (120 * 2 * 10) / 10_000;
    expect(t.qty).toBeCloseTo(Math.floor((1_000 / (120 - stop + costPerUnit)) * 1e8) / 1e8, 8);
    expect(t.exitReason).toBe("stop");
    expect(t.exitTime).toBe(hit + H1);
    expect(t.exitPrice).toBeCloseTo(stop * (1 - s), 10);
    expect(r.trades).toHaveLength(1);
  });

  it("(b) re-enters at the next weekly close still above after a stop-out", () => {
    const w = weeks([120, 125, 130]);
    const stop = 120 - 2 * value(computePineATR(w, 14), W0 + 55 * W1);
    const hit = W0 + 56 * W1 + H4;
    const { h4, h1 } = intraday(56, 59, 110, { [hit]: { open: stop - 2, low: stop - 3 } });
    const r = runBaseline({ kind: "b", h4, h1, w1: w, costs: COSTS, startIndex: 0, endIndex: h4.length, startEquity: 100_000 });
    expect(r.trades[0]!.exitReason).toBe("stop");
    expect(r.trades[0]!.exitPrice).toBeCloseTo((stop - 2) * (1 - s), 10); // gapped through: fills at the open
    expect(r.trades[1]!.entryTime).toBe(W0 + 57 * W1);
    expect(r.trades[1]!.stop).toBeCloseTo(125 - 2 * value(computePineATR(w, 14), W0 + 56 * W1), 10);
  });

  it("stays flat when the signal in force is below SMA 50", () => {
    const w = weeks([80]);
    expect(value(computeSMA(w, 50), W0 + 55 * W1)).toBeGreaterThan(80);
    const { h4, h1 } = intraday(56, 57, 80);
    const r = runBaseline({ kind: "a", h4, h1, w1: w, costs: COSTS, startIndex: 0, endIndex: h4.length, startEquity: 100_000 });
    expect(r.trades).toHaveLength(0);
    expect(r.equity.at(-1)!.equity).toBe(100_000);
  });

  it("endIndex: closes at the last bar before it and never reads past it", () => {
    const { h4, h1 } = intraday(56, 58, 110);
    const r = runBaseline({ kind: "a", h4, h1, w1, costs: COSTS, startIndex: 0, endIndex: 10, startEquity: 100_000 });
    expect(r.equity).toHaveLength(10);
    expect(r.trades[0]!.exitReason).toBe("end_of_data");
    expect(r.trades[0]!.exitTime).toBe(h4[9]!.time + H4);
  });
});
