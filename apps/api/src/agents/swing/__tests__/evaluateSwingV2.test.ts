/**
 * Swing Agent v2's rules on hand-built snapshots, each at its approved number
 * (swingParamsV2.ts): weekly SMA 50 bias with no neutral zone, room on
 * daily/weekly S/R only (>= 1.0R), no target, no time stop, exit on a 4h
 * close across EMA 50, and v1's setup/stop/limits unchanged.
 */
import { describe, it, expect } from "vitest";
import { evaluateSwing, type SwingAccount, type SwingPosition } from "../evaluateSwing";
import { evaluateSwingV2, SWING_V2_REASON_CODES } from "../evaluateSwingV2";
import type { SwingLevel, SwingSnapshot } from "../swingSeries";
import { SWING_PARAMS_V2 } from "../swingParamsV2";

const H4 = 14_400;
const T0 = 1_780_000_000 - (1_780_000_000 % H4);
const COSTS = { takerFeeBps: 5, slippageBps: 5 };

function level(over: Partial<SwingLevel>): SwingLevel {
  return { id: "L1", tf: "4h", role: "support", top: 0, bottom: 0, touches: 1, ...over };
}

/**
 * A clean long at 100,000, ATR 1,000: stop 98,000 (behind the 4h support, 2 ATR),
 * so 1R = 2,000. A 4h resistance sits 0.5R away (blocked v1, ignored by v2).
 */
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
    utStop: null,
    utSignal: null,
    weekly: { barTime: T0 - 7 * 86_400, close: 100_000, sma50: 80_000, sma200: 60_000 },
    daily: { barTime: T0 - 86_400, close: 100_000, sma200: 90_000 },
    pdh: 99_800,
    pdl: 97_000,
    pwh: 100_500,
    pwl: 90_000,
    levels: [
      level({ id: "S4", tf: "4h", role: "support", bottom: 98_200, top: 98_500 }),
      level({ id: "R4", tf: "4h", role: "resistance", bottom: 101_000, top: 101_300 }),
    ],
    levels1w: [],
    ...over,
  };
}

/** The mirror short at 100,000: stop 102,000 behind the 4h resistance. */
function shortSnap(over: Partial<SwingSnapshot> = {}): SwingSnapshot {
  return longSnap({
    open: 100_500,
    high: 101_000,
    low: 99_800,
    ema20: 100_400,
    ema50: 102_000,
    rsi14: 45,
    window: [
      { time: T0 - 2 * H4, low: 99_900, high: 100_300, close: 100_100, ema20: 100_450, ema50: 102_100 },
      { time: T0 - H4, low: 100_050, high: 100_600, close: 100_350, ema20: 100_420, ema50: 102_050 },
      { time: T0, low: 99_800, high: 101_000, close: 100_000, ema20: 100_400, ema50: 102_000 },
    ],
    weekly: { barTime: T0 - 7 * 86_400, close: 100_000, sma50: 120_000, sma200: 140_000 },
    daily: { barTime: T0 - 86_400, close: 100_000, sma200: 110_000 },
    levels: [
      level({ id: "R4", tf: "4h", role: "resistance", bottom: 101_500, top: 101_800 }),
      level({ id: "S4", tf: "4h", role: "support", bottom: 98_700, top: 99_000 }),
    ],
    ...over,
  });
}

function account(over: Partial<SwingAccount> = {}): SwingAccount {
  return { equity: 100_000, peakEquity: 100_000, dayStartEquity: 100_000, entriesToday: 0, killed: false, position: null, lastExitTime: null, ...over };
}

function held(side: "long" | "short", over: Partial<SwingPosition> = {}): SwingPosition {
  return { side, entryBarTime: T0 - 100 * H4, qty: 0.5, entryPrice: 100_000, stop: side === "long" ? 98_000 : 102_000, target: null, ...over };
}

describe("evaluateSwingV2", () => {
  it("the approved numbers", () => {
    expect(SWING_PARAMS_V2.weeklySma).toBe(50);
    expect(SWING_PARAMS_V2.room).toEqual({ minR: 1.0, timeframes: ["1d", "1w"] });
    expect(SWING_PARAMS_V2.sr1w).toEqual({ left: 3, right: 3 });
    expect(SWING_PARAMS_V2.exit.ema).toBe(50);
    expect(SWING_PARAMS_V2.adx.min).toBe(20);
    expect("timeStopBars" in SWING_PARAMS_V2.limits).toBe(false);
  });

  it("enters long with no target, sized to 1% risk, and records the room", () => {
    const d = evaluateSwingV2(longSnap(), account(), COSTS);
    expect(d.action).toBe("ENTER_LONG");
    expect(d.reasonCode).toBe("entry");
    expect(d.plan!.stop).toBe(98_000);
    expect(d.plan!.r).toBe(2_000);
    expect(d.plan!.target).toBeNull();
    expect(d.plan!.roomR).toBeNull();
    expect(d.roomR).toBe("none");
    const costPerUnit = (100_000 * 2 * 10) / 10_000;
    expect(d.plan!.qty).toBeCloseTo(1_000 / (2_000 + costPerUnit), 7);
  });

  it("the same snapshot is blocked by v1 on its 4h room: v2 ignores 4h levels for room", () => {
    expect(evaluateSwing(longSnap(), account(), "A", COSTS).reasonCode).toBe("room_to_target");
    expect(evaluateSwingV2(longSnap(), account(), COSTS).action).toBe("ENTER_LONG");
  });

  it("enters short as the mirror", () => {
    const d = evaluateSwingV2(shortSnap(), account(), COSTS);
    expect(d.action).toBe("ENTER_SHORT");
    expect(d.plan!.stop).toBe(102_000);
    expect(d.plan!.target).toBeNull();
  });

  describe("weekly bias: SMA 50 only, no neutral zone", () => {
    it("long when the weekly close is above SMA 50 even if it is below SMA 200 (v1: neutral)", () => {
      const s = longSnap({ weekly: { barTime: T0 - 7 * 86_400, close: 100_000, sma50: 90_000, sma200: 120_000 } });
      expect(evaluateSwing(s, account(), "A", COSTS).reasonCode).toBe("bias_neutral");
      expect(evaluateSwingV2(s, account(), COSTS).action).toBe("ENTER_LONG");
    });

    it("short bias below SMA 50: a long setup is then tested as a short and fails", () => {
      const s = longSnap({ weekly: { barTime: T0 - 7 * 86_400, close: 100_000, sma50: 110_000, sma200: 60_000 } });
      const d = evaluateSwingV2(s, account(), COSTS);
      expect(d.candidateSide).toBe("short");
      expect(d.reasonCode).toBe("daily_disagrees");
    });

    it("exactly on SMA 50 is the only neutral case", () => {
      const s = longSnap({ weekly: { barTime: T0 - 7 * 86_400, close: 100_000, sma50: 100_000, sma200: null } });
      expect(evaluateSwingV2(s, account(), COSTS).reasonCode).toBe("bias_neutral");
    });

    it("does not need the weekly SMA 200", () => {
      const s = longSnap({ weekly: { barTime: T0 - 7 * 86_400, close: 100_000, sma50: 80_000, sma200: null } });
      expect(evaluateSwingV2(s, account(), COSTS).action).toBe("ENTER_LONG");
    });
  });

  describe("room: nearest opposing daily/weekly S/R >= 1.0R", () => {
    const withLevel = (l: SwingLevel, weekly = false) =>
      weekly ? longSnap({ levels1w: [l] }) : longSnap({ levels: [...longSnap().levels, l] });

    it("a daily resistance 0.9R away blocks (room_htf)", () => {
      const d = evaluateSwingV2(withLevel(level({ tf: "1d", role: "resistance", bottom: 101_800, top: 102_000 })), account(), COSTS);
      expect(d.reasonCode).toBe("room_htf");
      expect(d.roomR).toBeCloseTo(0.9, 10);
    });

    it("a weekly resistance 0.9R away blocks", () => {
      const d = evaluateSwingV2(withLevel(level({ tf: "1w", role: "resistance", bottom: 101_800, top: 102_500 }), true), account(), COSTS);
      expect(d.reasonCode).toBe("room_htf");
    });

    it("exactly 1.0R passes", () => {
      const d = evaluateSwingV2(withLevel(level({ tf: "1d", role: "resistance", bottom: 102_000, top: 102_300 })), account(), COSTS);
      expect(d.action).toBe("ENTER_LONG");
      expect(d.plan!.roomR).toBeCloseTo(1, 10);
    });

    it("price inside a weekly resistance zone is 0R and blocks", () => {
      const d = evaluateSwingV2(withLevel(level({ tf: "1w", role: "resistance", bottom: 99_000, top: 100_500 }), true), account(), COSTS);
      expect(d.reasonCode).toBe("room_htf");
      expect(d.roomR).toBe(0);
    });

    it("short: a daily support 0.5R below blocks", () => {
      const s = shortSnap({ levels: [...shortSnap().levels, level({ tf: "1d", role: "support", bottom: 98_500, top: 99_000 })] });
      expect(evaluateSwingV2(s, account(), COSTS).reasonCode).toBe("room_htf");
    });
  });

  describe("exit: a 4h close across EMA 50, no time stop", () => {
    it("long: a close below EMA 50 exits", () => {
      const d = evaluateSwingV2(longSnap({ close: 97_999, ema50: 98_000 }), account({ position: held("long") }), COSTS);
      expect(d.action).toBe("EXIT_TREND");
      expect(d.reasonCode).toBe("trend_exit");
      expect(d.side).toBe("long");
    });

    it("long: a close exactly on EMA 50 holds; a close above holds", () => {
      expect(evaluateSwingV2(longSnap({ close: 98_000, ema50: 98_000 }), account({ position: held("long") }), COSTS).action).toBe("HOLD");
      expect(evaluateSwingV2(longSnap(), account({ position: held("long") }), COSTS).action).toBe("HOLD");
    });

    it("short: a close above EMA 50 exits", () => {
      const d = evaluateSwingV2(shortSnap({ close: 102_001, ema50: 102_000 }), account({ position: held("short") }), COSTS);
      expect(d.action).toBe("EXIT_TREND");
    });

    it("holds a position 100 bars old (v1 would have time-stopped at 42)", () => {
      const pos = held("long", { entryBarTime: T0 - 100 * H4 });
      expect(evaluateSwing(longSnap(), account({ position: { ...pos, target: 110_000 } }), "A", COSTS).action).toBe("EXIT_TIME");
      expect(evaluateSwingV2(longSnap(), account({ position: pos }), COSTS).action).toBe("HOLD");
    });

    it("exits even when the kill switch is on (exits are never blocked)", () => {
      const d = evaluateSwingV2(longSnap({ close: 97_000 }), account({ position: held("long"), killed: true }), COSTS);
      expect(d.action).toBe("EXIT_TREND");
    });
  });

  describe("unchanged from v1", () => {
    it("the pullback setup: RSI out of band → no_setup", () => {
      expect(evaluateSwingV2(longSnap({ rsi14: 66 }), account(), COSTS).reasonCode).toBe("no_setup");
      expect(evaluateSwing(longSnap({ rsi14: 66 }), account(), "A", COSTS).reasonCode).toBe("no_setup");
    });

    it("ADX under 20 → adx_weak; daily disagreeing → daily_disagrees", () => {
      expect(evaluateSwingV2(longSnap({ adx: 19.99 }), account(), COSTS).reasonCode).toBe("adx_weak");
      expect(evaluateSwingV2(longSnap({ daily: { barTime: T0 - 86_400, close: 100_000, sma200: 100_001 } }), account(), COSTS).reasonCode).toBe("daily_disagrees");
    });

    it("stop outside 0.5%–8% → stop_invalid", () => {
      expect(evaluateSwingV2(longSnap({ atr14: 10_000, levels: [] }), account(), COSTS).reasonCode).toBe("stop_invalid");
    });

    it("account gates in v1 order", () => {
      expect(evaluateSwingV2(longSnap(), account({ killed: true }), COSTS).reasonCode).toBe("killed");
      expect(evaluateSwingV2(longSnap(), account({ equity: 85_000 }), COSTS).reasonCode).toBe("halted_drawdown");
      expect(evaluateSwingV2(longSnap(), account({ equity: 97_000, peakEquity: 97_000 }), COSTS).reasonCode).toBe("daily_loss_limit");
      expect(evaluateSwingV2(longSnap(), account({ entriesToday: 2 }), COSTS).reasonCode).toBe("max_trades_today");
      expect(evaluateSwingV2(longSnap(), account({ lastExitTime: T0 + H4 - 60 }), COSTS).reasonCode).toBe("cooldown");
      expect(evaluateSwingV2(longSnap({ ema20: null }), account(), COSTS).reasonCode).toBe("warmup");
    });

    it("requests the halt at the drawdown limit", () => {
      expect(evaluateSwingV2(longSnap(), account({ equity: 85_000 }), COSTS).requestHalt).toBe(true);
    });
  });

  it("every reason code it returns is listed", () => {
    const seen = new Set<string>();
    const snaps = [longSnap(), longSnap({ rsi14: 70 }), longSnap({ adx: 1 }), longSnap({ ema20: null })];
    for (const s of snaps) seen.add(evaluateSwingV2(s, account(), COSTS).reasonCode);
    for (const c of seen) expect(SWING_V2_REASON_CODES).toContain(c);
  });
});
