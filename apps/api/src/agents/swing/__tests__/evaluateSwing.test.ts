/**
 * The Swing Agent's rules on hand-built snapshots: every entry rule, every
 * "do nothing" reason, the stop/target/size math and the account limits, each
 * at its exact approved number (swingParams.ts).
 */
import { describe, it, expect } from "vitest";
import { evaluateSwing, SWING_REASON_CODES, type SwingAccount, type SwingCosts } from "../evaluateSwing";
import type { SwingLevel, SwingSnapshot } from "../swingSeries";
import { SWING_PARAMS } from "../swingParams";

const H4 = 14_400;
const T0 = 1_780_000_000 - (1_780_000_000 % H4); // a 4h-aligned bar open

function level(over: Partial<SwingLevel>): SwingLevel {
  return { id: "L1", tf: "4h", role: "support", top: 0, bottom: 0, touches: 1, ...over };
}

/** A clean Variant A long at 100,000 with ATR 1,000: structural stop 98,000 (2 ATR), target 2R = 104,000. */
function longSnap(over: Partial<SwingSnapshot> = {}): SwingSnapshot {
  return {
    barTime: T0,
    closeTime: T0 + H4,
    open: 99_500,
    high: 100_200,
    low: 99_000,
    close: 100_000,
    ema20: 99_600,
    ema50: 98_000,
    rsi14: 55,
    adx: 25,
    plusDI: 28,
    minusDI: 14,
    atr14: 1_000,
    window: [
      { time: T0 - 2 * H4, low: 99_700, high: 100_100, close: 99_900, ema20: 99_550, ema50: 97_900 },
      { time: T0 - H4, low: 99_400, high: 99_950, close: 99_650, ema20: 99_580, ema50: 97_950 },
      { time: T0, low: 99_000, high: 100_200, close: 100_000, ema20: 99_600, ema50: 98_000 },
    ],
    utStop: 98_900,
    utSignal: null,
    weekly: { barTime: T0 - 7 * 86_400, close: 100_000, sma50: 80_000, sma200: 60_000 },
    daily: { barTime: T0 - 86_400, close: 100_000, sma200: 90_000 },
    pdh: 99_800,
    pdl: 97_000,
    pwh: 110_000,
    pwl: 90_000,
    levels: [
      level({ id: "S4", tf: "4h", role: "support", bottom: 98_200, top: 98_500 }),
      level({ id: "R4", tf: "4h", role: "resistance", bottom: 106_000, top: 106_500 }),
    ],
    ...over,
  };
}

/** The mirror: a Variant B short at 100,000, structural stop 102,000, target 96,000. */
function shortSnap(over: Partial<SwingSnapshot> = {}): SwingSnapshot {
  return longSnap({
    open: 100_500,
    high: 101_000,
    low: 99_800,
    ema20: 100_400,
    ema50: 102_000,
    rsi14: 45,
    plusDI: 14,
    minusDI: 28,
    window: [
      { time: T0 - 2 * H4, low: 99_900, high: 100_300, close: 100_100, ema20: 100_450, ema50: 102_100 },
      { time: T0 - H4, low: 100_050, high: 100_600, close: 100_350, ema20: 100_420, ema50: 102_050 },
      { time: T0, low: 99_800, high: 101_000, close: 100_000, ema20: 100_400, ema50: 102_000 },
    ],
    utSignal: "sell",
    utStop: 101_100,
    weekly: { barTime: T0 - 7 * 86_400, close: 100_000, sma50: 120_000, sma200: 140_000 },
    daily: { barTime: T0 - 86_400, close: 100_000, sma200: 110_000 },
    pdh: 103_000,
    pdl: 100_200,
    pwh: 110_000,
    pwl: 90_000,
    levels: [
      level({ id: "R4", tf: "4h", role: "resistance", bottom: 101_500, top: 101_800 }),
      level({ id: "S4", tf: "4h", role: "support", bottom: 93_500, top: 94_000 }),
    ],
    ...over,
  });
}

function account(over: Partial<SwingAccount> = {}): SwingAccount {
  return {
    equity: 100_000,
    peakEquity: 100_000,
    dayStartEquity: 100_000,
    entriesToday: 0,
    killed: false,
    position: null,
    lastExitTime: null,
    ...over,
  };
}

const COSTS: SwingCosts = { takerFeeBps: 5, slippageBps: 5 };
const rule = (d: ReturnType<typeof evaluateSwing>, id: string) => d.rules.find((r) => r.id === id)!;

describe("approved parameters", () => {
  it("pins every number the user approved", () => {
    expect(SWING_PARAMS).toEqual({
      timeframeSec: 14_400,
      weeklySma: { fast: 50, slow: 200 },
      dailySma: 200,
      adx: { diLength: 14, adxSmoothing: 14, min: 20 },
      pullback: { emaFast: 20, emaSlow: 50, lookbackBars: 3, rsiPeriod: 14, rsiLong: [40, 65], rsiShort: [35, 60] },
      utBot: { keyValue: 1, atrPeriod: 10 },
      atrPeriod: 14,
      sr4h: { left: 10, right: 10 },
      sr1d: { left: 5, right: 5 },
      levelsPerSide: 5,
      stop: { structureBufferAtr: 0.2, structureMinAtr: 1.0, structureMaxAtr: 3.0, atrMult: 1.5, minPct: 0.005, maxPct: 0.08 },
      target: { r: 2.0, minR: 1.5, levelBufferAtr: 0.1, minRoomR: 1.5 },
      risk: { perTrade: 0.01, maxNotionalOfEquity: 1.0 },
      limits: { dailyLossPct: 0.03, maxEntriesPerDay: 2, cooldownSec: 14_400, drawdownHaltPct: 0.15, timeStopBars: 42 },
    });
  });
});

describe("entries", () => {
  it("Variant A: long pullback with a structural stop and a 2R target", () => {
    const d = evaluateSwing(longSnap(), account(), "A", COSTS);
    expect(d.action).toBe("ENTER_LONG");
    expect(d.reasonCode).toBe("entry");
    expect(d.side).toBe("long");
    const p = d.plan!;
    expect(p.entryRef).toBe(100_000);
    expect(p.stop).toBe(98_000);
    expect(p.stopSource).toBe("structure_4h");
    expect(p.r).toBe(2_000);
    expect(p.target).toBe(104_000);
    expect(p.targetSource).toBe("2R");
    expect(p.targetR).toBe(2);
    // risk 1,000 / (2,000 + 100,000 × 2 × 10 bps = 200) per BTC, floored to 8 dp.
    expect(p.riskUsd).toBe(1_000);
    expect(p.qty).toBe(0.45454545);
    expect(p.notional).toBeCloseTo(45_454.545, 6);
    expect(p.sizeCapped).toBe(false);
    expect(d.reason).toMatch(/^Enter long/);
  });

  it("Variant B: short on a UT Bot sell with the mirror stop/target", () => {
    const d = evaluateSwing(shortSnap(), account(), "B", COSTS);
    expect(d.action).toBe("ENTER_SHORT");
    const p = d.plan!;
    expect(p.stop).toBe(102_000); // 101,800 + 0.2 × 1,000
    expect(p.r).toBe(2_000);
    expect(p.target).toBe(96_000);
    expect(p.targetSource).toBe("2R");
  });

  it("Variant A short mirrors the long rules (RSI band 35–60)", () => {
    const d = evaluateSwing(shortSnap({ utSignal: null }), account(), "A", COSTS);
    expect(d.action).toBe("ENTER_SHORT");
    expect(rule(d, "a_rsi").pass).toBe(true);
  });

  it("caps the notional at 100% of equity (1x) and says so", () => {
    // ATR 300: structural stop 0.6 ATR → ATR stop 450 (0.45%) is under 0.5% → widen the ATR so the stop is valid but tight.
    const snap = longSnap({
      atr14: 400,
      levels: [level({ id: "R4", tf: "4h", role: "resistance", bottom: 106_000, top: 106_500 })],
    });
    const d = evaluateSwing(snap, account(), "A", COSTS);
    expect(d.action).toBe("ENTER_LONG");
    const p = d.plan!;
    expect(p.stopSource).toBe("atr");
    expect(p.r).toBe(600); // 1.5 × 400
    expect(p.qty).toBe(1); // risk sizing wants 1,000 / 800 = 1.25 BTC; the cap is 100,000 / 100,000
    expect(p.sizeCapped).toBe(true);
    expect(p.notional).toBe(100_000);
  });
});

describe("do-nothing reasons, each at its boundary", () => {
  it("weekly close between the SMAs is neutral", () => {
    const d = evaluateSwing(longSnap({ weekly: { barTime: 0, close: 70_000, sma50: 80_000, sma200: 60_000 } }), account(), "A", COSTS);
    expect(d.action).toBe("NO_TRADE");
    expect(d.reasonCode).toBe("bias_neutral");
    expect(d.reason).toContain("70,000.00");
  });

  it("daily close must agree with the weekly bias", () => {
    const d = evaluateSwing(longSnap({ daily: { barTime: 0, close: 89_000, sma200: 90_000 } }), account(), "A", COSTS);
    expect(d.reasonCode).toBe("daily_disagrees");
  });

  it("ADX 20 passes, 19.99 does not", () => {
    expect(evaluateSwing(longSnap({ adx: 20 }), account(), "A", COSTS).action).toBe("ENTER_LONG");
    const d = evaluateSwing(longSnap({ adx: 19.99 }), account(), "A", COSTS);
    expect(d.reasonCode).toBe("adx_weak");
  });

  it("RSI band [40, 65] is inclusive for longs", () => {
    expect(evaluateSwing(longSnap({ rsi14: 40 }), account(), "A", COSTS).action).toBe("ENTER_LONG");
    expect(evaluateSwing(longSnap({ rsi14: 65 }), account(), "A", COSTS).action).toBe("ENTER_LONG");
    expect(evaluateSwing(longSnap({ rsi14: 39.9 }), account(), "A", COSTS).reasonCode).toBe("no_setup");
    expect(evaluateSwing(longSnap({ rsi14: 65.1 }), account(), "A", COSTS).reasonCode).toBe("no_setup");
  });

  it("no pullback: no low in the last 3 bars reached EMA 20", () => {
    const snap = longSnap();
    const window = snap.window.map((b) => ({ ...b, low: b.ema20! + 50 }));
    const d = evaluateSwing({ ...snap, window, low: window[2]!.low }, account(), "A", COSTS);
    expect(d.reasonCode).toBe("no_setup");
    expect(rule(d, "a_pullback").pass).toBe(false);
    expect(d.reason).toContain("EMA 20");
  });

  it("a close below EMA 50 in the pullback window fails A", () => {
    const snap = longSnap();
    const window = [{ ...snap.window[0]!, close: 97_800 }, snap.window[1]!, snap.window[2]!];
    const d = evaluateSwing({ ...snap, window }, account(), "A", COSTS);
    expect(rule(d, "a_hold_ema50").pass).toBe(false);
    expect(d.reasonCode).toBe("no_setup");
  });

  it("A needs a bullish reclaim bar: close above EMA 20 and above the open", () => {
    const d = evaluateSwing(longSnap({ open: 100_100 }), account(), "A", COSTS);
    expect(rule(d, "a_reclaim").pass).toBe(false);
    expect(d.reasonCode).toBe("no_setup");
  });

  it("B: no signal, or a signal against the bias, is no setup", () => {
    expect(evaluateSwing(longSnap(), account(), "B", COSTS).reasonCode).toBe("no_setup");
    const d = evaluateSwing(longSnap({ utSignal: "sell" }), account(), "B", COSTS);
    expect(d.reasonCode).toBe("no_setup");
    expect(d.reason).toContain("against");
  });

  it("structural stop under 1.0 ATR away falls back to 1.5 ATR", () => {
    // support bottom 99,300 → stop 99,100, 0.9 ATR away.
    const snap = longSnap({ levels: [level({ id: "S", role: "support", bottom: 99_300, top: 99_400 }), level({ id: "R", role: "resistance", bottom: 106_000, top: 106_500 })] });
    const p = evaluateSwing(snap, account(), "A", COSTS).plan!;
    expect(p.stopSource).toBe("atr");
    expect(p.stop).toBe(98_500);
  });

  it("structural stop over 3.0 ATR away falls back to 1.5 ATR; exactly 3.0 is structural", () => {
    const far = longSnap({ levels: [level({ id: "S", role: "support", bottom: 96_700, top: 97_000 }), level({ id: "R", role: "resistance", bottom: 106_000, top: 106_500 })] });
    expect(evaluateSwing(far, account(), "A", COSTS).plan!.stopSource).toBe("atr");
    const edge = longSnap({ levels: [level({ id: "S", role: "support", bottom: 97_200, top: 97_500 }), level({ id: "R", role: "resistance", bottom: 109_000, top: 109_500 })] });
    const p = evaluateSwing(edge, account(), "A", COSTS).plan!;
    expect(p.stopSource).toBe("structure_4h");
    expect(p.stop).toBe(97_000);
  });

  it("a daily support is a structural stop too", () => {
    const snap = longSnap({ levels: [level({ id: "D", tf: "1d", role: "support", bottom: 98_200, top: 98_400 }), level({ id: "R", role: "resistance", bottom: 106_000, top: 106_500 })] });
    expect(evaluateSwing(snap, account(), "A", COSTS).plan!.stopSource).toBe("structure_1d");
  });

  it("stop distance outside 0.5%–8% of price is invalid", () => {
    // ATR 300 and no support: 1.5 ATR = 450 = 0.45%.
    const tight = longSnap({ atr14: 300, levels: [] });
    expect(evaluateSwing(tight, account(), "A", COSTS).reasonCode).toBe("stop_invalid");
    // ATR 6,000: 1.5 ATR = 9,000 = 9%.
    const wide = longSnap({ atr14: 6_000, levels: [] });
    expect(evaluateSwing(wide, account(), "A", COSTS).reasonCode).toBe("stop_invalid");
  });

  it("an opposing S/R level under 1.5R away blocks the entry; exactly 1.5R passes", () => {
    const near = longSnap({ levels: [level({ id: "S", role: "support", bottom: 98_200, top: 98_500 }), level({ id: "R", role: "resistance", bottom: 102_999, top: 103_200 })] });
    const d = evaluateSwing(near, account(), "A", COSTS);
    expect(d.reasonCode).toBe("room_to_target");
    expect(d.reason).toContain("1.50R");
    // Exactly 1.5R = 3,000 away: room passes, but the target in front of it
    // (103,000 − 0.1 ATR = 102,900, 1.45R) is under 1.5R.
    const edge = longSnap({ levels: [level({ id: "S", role: "support", bottom: 98_200, top: 98_500 }), level({ id: "R", role: "resistance", bottom: 103_000, top: 103_200 })] });
    const e = evaluateSwing(edge, account(), "A", COSTS);
    expect(rule(e, "room").pass).toBe(true);
    expect(e.reasonCode).toBe("target_too_close");
  });

  it("price inside a resistance zone has zero room", () => {
    const inside = longSnap({ levels: [level({ id: "S", role: "support", bottom: 98_200, top: 98_500 }), level({ id: "R", role: "resistance", bottom: 99_900, top: 100_300 })] });
    expect(evaluateSwing(inside, account(), "A", COSTS).reasonCode).toBe("room_to_target");
  });

  it("the target stops in front of a closer S/R level", () => {
    // Resistance at 103,700 (1.85R): target 103,600 = 1.8R.
    const snap = longSnap({ levels: [level({ id: "S", role: "support", bottom: 98_200, top: 98_500 }), level({ id: "R", tf: "1d", role: "resistance", bottom: 103_700, top: 104_000 })] });
    const p = evaluateSwing(snap, account(), "A", COSTS).plan!;
    expect(p.target).toBe(103_600);
    expect(p.targetSource).toBe("sr_1d");
    expect(p.targetR).toBeCloseTo(1.8, 12);
  });

  it("PDH / PWH cap the target; under 1.5R it's target_too_close", () => {
    const pdh = evaluateSwing(longSnap({ pdh: 103_500 }), account(), "A", COSTS);
    expect(pdh.plan!.target).toBe(103_400);
    expect(pdh.plan!.targetSource).toBe("pdh");
    const pwh = evaluateSwing(longSnap({ pwh: 102_000 }), account(), "A", COSTS);
    expect(pwh.reasonCode).toBe("target_too_close");
    expect(pwh.plan).toBeNull();
    // Shorts use PDL / PWL.
    const pdl = evaluateSwing(shortSnap({ pdl: 96_500 }), account(), "B", COSTS);
    expect(pdl.plan!.target).toBe(96_600);
    expect(pdl.plan!.targetSource).toBe("pdl");
  });

  it("missing inputs are warm-up, never a trade", () => {
    for (const over of [{ weekly: null }, { daily: null }, { adx: null }, { atr14: null }, { rsi14: null }, { window: [] }] as Partial<SwingSnapshot>[]) {
      const d = evaluateSwing(longSnap(over), account(), "A", COSTS);
      expect(d.action).toBe("NO_TRADE");
      expect(d.reasonCode).toBe("warmup");
    }
    const sma = evaluateSwing(longSnap({ weekly: { barTime: 0, close: 100_000, sma50: 80_000, sma200: null } }), account(), "A", COSTS);
    expect(sma.reasonCode).toBe("warmup");
  });
});

describe("account limits", () => {
  it("kill switch blocks entries", () => {
    const d = evaluateSwing(longSnap(), account({ killed: true }), "A", COSTS);
    expect(d.action).toBe("NO_TRADE");
    expect(d.reasonCode).toBe("killed");
  });

  it("equity at 85% of peak halts and asks for the kill switch", () => {
    const d = evaluateSwing(longSnap(), account({ equity: 85_000, peakEquity: 100_000, dayStartEquity: 85_000 }), "A", COSTS);
    expect(d.reasonCode).toBe("halted_drawdown");
    expect(d.requestHalt).toBe(true);
    const ok = evaluateSwing(longSnap(), account({ equity: 85_001, peakEquity: 100_000, dayStartEquity: 85_001 }), "A", COSTS);
    expect(ok.action).toBe("ENTER_LONG");
    expect(ok.requestHalt).toBe(false);
  });

  it("an already-killed agent doesn't ask again", () => {
    const d = evaluateSwing(longSnap(), account({ killed: true, equity: 80_000, dayStartEquity: 80_000 }), "A", COSTS);
    expect(d.reasonCode).toBe("killed");
    expect(d.requestHalt).toBe(false);
  });

  it("−3% on the UTC day stops new entries", () => {
    expect(evaluateSwing(longSnap(), account({ equity: 97_000, peakEquity: 100_000 }), "A", COSTS).reasonCode).toBe("daily_loss_limit");
    expect(evaluateSwing(longSnap(), account({ equity: 97_001, peakEquity: 100_000 }), "A", COSTS).action).toBe("ENTER_LONG");
  });

  it("max 2 entries per UTC day", () => {
    expect(evaluateSwing(longSnap(), account({ entriesToday: 1 }), "A", COSTS).action).toBe("ENTER_LONG");
    expect(evaluateSwing(longSnap(), account({ entriesToday: 2 }), "A", COSTS).reasonCode).toBe("max_trades_today");
  });

  it("cooldown: a full 4h bar between an exit and the next entry decision", () => {
    const close = T0 + H4;
    expect(evaluateSwing(longSnap(), account({ lastExitTime: close - H4 + 1 }), "A", COSTS).reasonCode).toBe("cooldown");
    expect(evaluateSwing(longSnap(), account({ lastExitTime: close - H4 }), "A", COSTS).action).toBe("ENTER_LONG");
  });

  it("an open position is held; the 42nd bar closes it on time, even when killed", () => {
    const position = { side: "long" as const, entryBarTime: T0 - 40 * H4, qty: 0.5, entryPrice: 99_000, stop: 97_000, target: 103_000 };
    const hold = evaluateSwing(longSnap(), account({ position }), "A", COSTS);
    expect(hold.action).toBe("HOLD");
    expect(hold.reasonCode).toBe("position_open");
    expect(hold.reason).toContain("bar 41 of 42");
    const exit = evaluateSwing(longSnap(), account({ position: { ...position, entryBarTime: T0 - 41 * H4 }, killed: true }), "A", COSTS);
    expect(exit.action).toBe("EXIT_TIME");
    expect(exit.reasonCode).toBe("time_stop");
  });
});

describe("every evaluation is fully explained", () => {
  const cases: Array<[string, ReturnType<typeof evaluateSwing>]> = [
    ["entry A", evaluateSwing(longSnap(), account(), "A", COSTS)],
    ["entry B", evaluateSwing(shortSnap(), account(), "B", COSTS)],
    ["neutral", evaluateSwing(longSnap({ weekly: { barTime: 0, close: 70_000, sma50: 80_000, sma200: 60_000 } }), account(), "A", COSTS)],
    ["killed", evaluateSwing(longSnap(), account({ killed: true }), "B", COSTS)],
    ["warmup", evaluateSwing(longSnap({ weekly: null, atr14: null }), account(), "A", COSTS)],
  ];

  it.each(cases)("%s: reports every rule, a known code and plain-English text", (_name, d) => {
    const ids = d.rules.map((r) => r.id);
    const common = ["kill_switch", "drawdown", "daily_loss", "entries_today", "cooldown", "flat", "data", "weekly_bias", "daily_filter", "adx", "stop", "room", "target"];
    const setup = d.variant === "A" ? ["a_trend", "a_above_ema50", "a_pullback", "a_reclaim", "a_hold_ema50", "a_rsi"] : ["b_signal"];
    expect(new Set(ids)).toEqual(new Set([...common, ...setup]));
    expect(SWING_REASON_CODES).toContain(d.reasonCode);
    expect(d.reason.length).toBeGreaterThan(20);
    for (const r of d.rules) {
      expect(r.label.length).toBeGreaterThan(0);
      expect([true, false, null]).toContain(r.pass);
    }
  });

  it("logs the side-dependent rules even when the bias is neutral (A: EMA order, B: the signal)", () => {
    const d = evaluateSwing(longSnap({ weekly: { barTime: 0, close: 70_000, sma50: 80_000, sma200: 60_000 }, utSignal: "buy" }), account(), "B", COSTS);
    expect(d.side).toBeNull();
    expect(d.candidateSide).toBe("long");
    expect(rule(d, "b_signal").pass).toBe(true);
    expect(rule(d, "weekly_bias").pass).toBe(false);
  });
});
