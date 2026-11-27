/**
 * Forward returns and the 7-day R outcome (pre-registration + addendum point 2).
 */
import { describe, it, expect } from "vitest";
import type { Candle } from "../../../../indicators/shared";
import { targetsAt, rOutcome, type Costs } from "../targets";

const H4 = 14_400;
const T0 = Date.parse("2021-03-01T00:00:00Z") / 1000;
const END = T0 + 400 * H4;
const BASE: Costs = { feeBps: 5, slippageBps: 5 };
const NONE: Costs = { feeBps: 0, slippageBps: 0 };

/** Flat bars at 100 (high 101, low 99) unless overridden. */
const bars = (n: number, over: Record<number, Partial<Candle>> = {}): Candle[] =>
  Array.from({ length: n }, (_, i) => ({ time: T0 + i * H4, open: 100, high: 101, low: 99, close: 100, volume: 1, ...over[i] }));

describe("rOutcome", () => {
  it("exits at bar k+42's close when the stop isn't touched", () => {
    const h4 = bars(60, { 42: { close: 103 } });
    const o = rOutcome(h4, 0, 2, 1, NONE); // 1R = 3, stop 97
    expect(o).toEqual({ r: 1, exitIndex: 42, exit: "time" });
    expect(rOutcome(h4, 0, 2, -1, NONE)!.r).toBeCloseTo(-1, 12);
  });

  it("stops at the stop price, or at the open when a bar gaps through it", () => {
    const touch = bars(60, { 5: { low: 96 } });
    expect(rOutcome(touch, 0, 2, 1, NONE)).toEqual({ r: -1, exitIndex: 5, exit: "stop" });
    const gap = bars(60, { 5: { open: 94, low: 93 } });
    expect(rOutcome(gap, 0, 2, 1, NONE)).toEqual({ r: -2, exitIndex: 5, exit: "stop" });
    const shortGap = bars(60, { 7: { open: 106, high: 107 } });
    expect(rOutcome(shortGap, 0, 2, -1, NONE)).toEqual({ r: -2, exitIndex: 7, exit: "stop" });
  });

  it("measures the stop from bar k+1's open, not from bar k's close", () => {
    const h4 = bars(60, { 0: { close: 110 }, 1: { open: 100 }, 10: { low: 97.5 } });
    expect(rOutcome(h4, 0, 2, 1, NONE)!.exit).toBe("time"); // stop 97, low 97.5
  });

  it("charges slippage on both fills and the fee on both notionals", () => {
    const h4 = bars(60, { 42: { close: 103 } });
    const o = rOutcome(h4, 0, 2, 1, BASE)!;
    const entry = 100 * 1.0005;
    const exit = 103 * 0.9995;
    expect(o.r).toBeCloseTo((exit - entry - 0.0005 * (entry + exit)) / 3, 12);
    const stress = rOutcome(h4, 0, 2, 1, { feeBps: 10, slippageBps: 10 })!;
    expect(stress.r).toBeLessThan(o.r);
  });
});

describe("targetsAt", () => {
  it("gives log returns from bar k+1's open to the close of k+6, k+18, k+42", () => {
    const h4 = bars(60, { 1: { open: 100 }, 6: { close: 110 }, 18: { close: 90 }, 42: { close: 100 } });
    const t = targetsAt(h4, 0, 2, END)!;
    expect(t.ret).toEqual([Math.log(1.1), Math.log(0.9), 0]);
    expect(t.longR).toBeCloseTo(rOutcome(h4, 0, 2, 1, BASE)!.r, 12);
    expect(t.shortRStress).toBeCloseTo(rOutcome(h4, 0, 2, -1, { feeBps: 10, slippageBps: 10 })!.r, 12);
  });

  it("is null when a bar is missing, ATR is missing, or k+42 closes at or after the window end", () => {
    const h4 = bars(60);
    expect(targetsAt(h4.filter((_, i) => i !== 20), 0, 2, END)).toBeNull();
    expect(targetsAt(h4, 0, null, END)).toBeNull();
    expect(targetsAt(h4, 0, 2, h4[42]!.time + H4)).toBeNull();
    expect(targetsAt(h4, 0, 2, h4[42]!.time + H4 + 1)).not.toBeNull();
    expect(targetsAt(h4, 30, 2, END)).toBeNull(); // runs off the data
  });
});
