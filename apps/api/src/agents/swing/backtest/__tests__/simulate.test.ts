/**
 * The backtest's fill model on hand-built candles, with a scripted decision
 * function: entries at the next 4h open, stop/target walked on the 1h bars
 * inside each 4h bar, gaps, stop-first on a tie, the drift guard, the time
 * stop, fees and slippage, and the account the rules see at each close.
 */
import { describe, it, expect } from "vitest";
import type { Candle } from "../../../../indicators/shared";
import type { SwingAccount, SwingDecision, SwingPlan } from "../../evaluateSwing";
import { simulate, type SimInput } from "../simulate";

const H1 = 3_600;
const H4 = 14_400;
const T0 = Date.UTC(2026, 0, 5) / 1000; // Monday 00:00 UTC

type Bar = Partial<Pick<Candle, "open" | "high" | "low" | "close">>;

/** n flat 4h bars at 100 (high 101, low 99) with their four 1h bars; `h1` overrides by [4h index, hour]. */
function market(n: number, h1Over: Record<string, Bar> = {}, h4Over: Record<number, Bar> = {}) {
  const h4: Candle[] = [];
  const h1: Candle[] = [];
  for (let k = 0; k < n; k++) {
    const t = T0 + k * H4;
    const hours: Candle[] = [];
    for (let h = 0; h < 4; h++) {
      hours.push({ time: t + h * H1, open: 100, high: 101, low: 99, close: 100, volume: 1, ...h1Over[`${k}:${h}`] });
    }
    h1.push(...hours);
    h4.push({
      time: t,
      open: hours[0]!.open,
      high: Math.max(...hours.map((c) => c.high)),
      low: Math.min(...hours.map((c) => c.low)),
      close: hours[3]!.close,
      volume: 4,
      ...h4Over[k],
    });
  }
  return { h4, h1 };
}

function plan(over: Partial<SwingPlan> = {}): SwingPlan {
  return {
    side: "long", entryRef: 100, stop: 98, stopSource: "atr", r: 2, target: 104, targetSource: "2R",
    targetR: 2, riskUsd: 1_000, qty: 1, notional: 100, sizeCapped: false, ...over,
  };
}

function decision(over: Partial<SwingDecision>): SwingDecision {
  return {
    barTime: 0, closeTime: 0, variant: "A", action: "NO_TRADE", side: null, candidateSide: null,
    reasonCode: "no_setup", reason: "", rules: [], plan: null, requestHalt: false,
    inputs: { adx: 30 } as SwingDecision["inputs"], ...over,
  };
}

const ENTER_LONG = decision({ action: "ENTER_LONG", side: "long", reasonCode: "entry", plan: plan() });
const ENTER_SHORT = decision({
  action: "ENTER_SHORT", side: "short", reasonCode: "entry",
  plan: plan({ side: "short", stop: 102, target: 96 }),
});

/** Scripted rules: `script[k]` at bar k's close; otherwise HOLD while in a position, NO_TRADE when flat. */
function scripted(script: Record<number, SwingDecision>, seen: SwingAccount[] = []): SimInput["decide"] {
  return (k, acct) => {
    seen[k] = structuredClone(acct);
    if (script[k]) return script[k]!;
    return acct.position
      ? decision({ action: "HOLD", side: acct.position.side, reasonCode: "position_open" })
      : decision({});
  };
}

const COSTS = { takerFeeBps: 5, slippageBps: 5 };
const s = 0.0005;
const f = 0.0005;

function run(h4: Candle[], h1: Candle[], decide: SimInput["decide"]) {
  return simulate({ h4, h1, decide, costs: COSTS, startIndex: 0, startEquity: 100_000 });
}

describe("simulate", () => {
  it("long: fills at the next 4h open plus slippage and exits at the target on the 1h bar that reaches it", () => {
    const { h4, h1 } = market(8, { "4:1": { high: 105 } });
    const r = run(h4, h1, scripted({ 2: ENTER_LONG }));
    expect(r.trades).toHaveLength(1);
    const t = r.trades[0]!;
    const entry = 100 * (1 + s);
    const exit = 104 * (1 - s);
    expect(t.side).toBe("long");
    expect(t.decisionTime).toBe(h4[2]!.time + H4);
    expect(t.entryTime).toBe(h4[3]!.time);
    expect(t.entryPrice).toBeCloseTo(entry, 12);
    expect(t.exitPrice).toBeCloseTo(exit, 12);
    expect(t.exitReason).toBe("target");
    expect(t.exitTime).toBe(h4[4]!.time + 2 * H1); // the end of the hour that hit it
    expect(t.feesUsd).toBeCloseTo((entry + exit) * f, 12);
    expect(t.pnlUsd).toBeCloseTo(exit - entry - (entry + exit) * f, 12);
    expect(t.riskUsd).toBeCloseTo(entry - 98, 12);
    expect(t.rMultiple).toBeCloseTo(t.pnlUsd / (entry - 98), 12);
    expect(t.barsHeld).toBe(2);
    expect(r.equity.at(-1)!.equity).toBeCloseTo(100_000 + t.pnlUsd, 9);
  });

  it("stop: intrabar at the stop price, or at the open when an hour gaps through it", () => {
    const intrabar = market(8, { "4:2": { low: 97.5 } });
    const a = run(intrabar.h4, intrabar.h1, scripted({ 2: ENTER_LONG })).trades[0]!;
    expect(a.exitReason).toBe("stop");
    expect(a.exitPrice).toBeCloseTo(98 * (1 - s), 12);

    const gap = market(8, { "4:2": { open: 96, high: 96.5, low: 95.5, close: 96 } });
    const b = run(gap.h4, gap.h1, scripted({ 2: ENTER_LONG })).trades[0]!;
    expect(b.exitReason).toBe("stop");
    expect(b.exitPrice).toBeCloseTo(96 * (1 - s), 12);
    expect(b.exitTime).toBe(gap.h4[4]!.time + 2 * H1); // the gapped hour's open
  });

  it("stop wins when one hour touches both", () => {
    const { h4, h1 } = market(8, { "3:3": { high: 105, low: 97 } });
    const t = run(h4, h1, scripted({ 2: ENTER_LONG })).trades[0]!;
    expect(t.exitReason).toBe("stop");
  });

  it("short mirrors it: slippage against the short on both sides", () => {
    const { h4, h1 } = market(8, { "3:2": { low: 95 } });
    const t = run(h4, h1, scripted({ 2: ENTER_SHORT })).trades[0]!;
    const entry = 100 * (1 - s);
    const exit = 96 * (1 + s);
    expect(t.entryPrice).toBeCloseTo(entry, 12);
    expect(t.exitPrice).toBeCloseTo(exit, 12);
    expect(t.exitReason).toBe("target");
    expect(t.pnlUsd).toBeCloseTo(entry - exit - (entry + exit) * f, 12);
  });

  it("drift guard: no entry when the next open is more than 0.25R from the decision close", () => {
    const moved = market(8, {}, {});
    moved.h1[3 * 4]!.open = 100.6;
    moved.h4[3]!.open = 100.6;
    const r = run(moved.h4, moved.h1, scripted({ 2: ENTER_LONG }));
    expect(r.trades).toHaveLength(0);
    expect(r.skippedDrift).toBe(1);

    const edge = market(8);
    edge.h1[3 * 4]!.open = 100.5; // exactly 0.25R
    edge.h4[3]!.open = 100.5;
    expect(run(edge.h4, edge.h1, scripted({ 2: ENTER_LONG })).trades).toHaveLength(1);
  });

  it("time stop: an EXIT_TIME decision closes at the next 4h open", () => {
    const { h4, h1 } = market(8);
    const exit = decision({ action: "EXIT_TIME", side: "long", reasonCode: "time_stop" });
    const t = run(h4, h1, scripted({ 2: ENTER_LONG, 5: exit })).trades[0]!;
    expect(t.exitReason).toBe("time");
    expect(t.exitTime).toBe(h4[6]!.time);
    expect(t.exitPrice).toBeCloseTo(100 * (1 - s), 12);
    expect(t.barsHeld).toBe(3); // bars 3, 4, 5
  });

  it("a position still open at the end is closed at the last close", () => {
    const { h4, h1 } = market(6);
    const t = run(h4, h1, scripted({ 2: ENTER_LONG })).trades[0]!;
    expect(t.exitReason).toBe("end_of_data");
    expect(t.exitTime).toBe(h4[5]!.time + H4);
  });

  it("feeds the rules the marked account: position, equity, entries per UTC day, last exit, halt", () => {
    // 6 bars per UTC day. Enter at bar 2's close (fill bar 3), stopped in bar 4.
    const { h4, h1 } = market(14, { "3:1": { close: 99 }, "3:3": { close: 99.5 }, "4:0": { low: 97 } });
    const seen: SwingAccount[] = [];
    const halt = decision({ requestHalt: true, reasonCode: "halted_drawdown" });
    run(h4, h1, scripted({ 2: ENTER_LONG, 9: halt }, seen));
    const entry = 100 * (1 + s);

    expect(seen[2]!.position).toBeNull();
    expect(seen[3]!.position).toEqual({ side: "long", entryBarTime: h4[3]!.time, qty: 1, entryPrice: entry, stop: 98, target: 104 });
    expect(seen[3]!.entriesToday).toBe(1);
    // Marked at bar 3's close (99.5), entry fee paid.
    expect(seen[3]!.equity).toBeCloseTo(100_000 - entry * (1 + f) + 99.5, 9);
    expect(seen[4]!.position).toBeNull();
    expect(seen[4]!.lastExitTime).toBe(h4[4]!.time + H1);
    expect(seen[4]!.peakEquity).toBe(100_000);
    // Bar 5 closes at 00:00 of the next UTC day: a new day.
    expect(seen[5]!.entriesToday).toBe(0);
    expect(seen[5]!.dayStartEquity).toBeCloseTo(seen[5]!.equity, 9);
    expect(seen[4]!.dayStartEquity).toBe(100_000);
    // requestHalt at bar 9 → killed from then on.
    expect(seen[9]!.killed).toBe(false);
    expect(seen[10]!.killed).toBe(true);
    expect(seen[13]!.killed).toBe(true);
  });

  it("reports the halt, bars in market, the equity curve and the reason counts", () => {
    const { h4, h1 } = market(10, { "5:0": { high: 105 } });
    const r = run(h4, h1, scripted({ 2: ENTER_LONG, 7: decision({ requestHalt: true, reasonCode: "halted_drawdown" }) }));
    expect(r.barsTotal).toBe(10);
    expect(r.barsInMarket).toBe(3); // bars 3, 4, 5
    expect(r.equity).toHaveLength(10);
    expect(r.equity[0]!.time).toBe(h4[0]!.time + H4);
    expect(r.haltedAt).toBe(h4[7]!.time + H4);
    expect(r.reasonCounts.entry).toBe(1);
    expect(r.reasonCounts.halted_drawdown).toBe(1);
    expect(r.fallbackBars).toBe(0);
  });

  it("walks the 4h bar itself when its 1h bars are missing", () => {
    const { h4 } = market(8, { "4:1": { high: 105 } });
    const r = run(h4, [], scripted({ 2: ENTER_LONG }));
    const t = r.trades[0]!;
    expect(t.exitReason).toBe("target");
    expect(t.exitTime).toBe(h4[4]!.time + H4);
    expect(r.fallbackBars).toBeGreaterThan(0);
  });

  it("starts at startIndex: no decisions or equity points before it", () => {
    const { h4, h1 } = market(8);
    const seen: SwingAccount[] = [];
    const r = simulate({ h4, h1, decide: scripted({}, seen), costs: COSTS, startIndex: 3, startEquity: 50_000 });
    expect(seen.slice(0, 3).every((x) => x === undefined)).toBe(true);
    expect(r.equity[0]).toEqual({ time: h4[3]!.time + H4, equity: 50_000 });
    expect(r.barsTotal).toBe(5);
  });
});
