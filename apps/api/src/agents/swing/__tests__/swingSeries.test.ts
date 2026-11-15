/**
 * The Swing Agent's inputs on real Coinbase BTC-USD candles (the shared
 * indicator fixture): values come straight from the shared indicator math, and
 * nothing at bar k depends on data after bar k's close.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  computeADX, computeEMA, computePineATR, computeRSI, computeSMA, computeUTBot, fixtureCandles,
  prevPeriodLevelSeries, type CandleFixture,
} from "../../../indicators/shared";
import type { Candle } from "../../../indicators/shared";
import { buildSwingSeries, snapshotAt, type SwingCandles } from "../swingSeries";
import { evaluateSwing, SWING_REASON_CODES, type SwingAccount } from "../evaluateSwing";

const H4 = 14_400;
const D1 = 86_400;
const W1 = 604_800;

const fixture = JSON.parse(
  readFileSync(new URL("../../../../../../packages/indicators/fixtures/btcusd-coinbase.json", import.meta.url), "utf8"),
) as CandleFixture;
const candles: SwingCandles = {
  h4: fixtureCandles(fixture.timeframes["4h"]!),
  d1: fixtureCandles(fixture.timeframes["1d"]!),
  w1: fixtureCandles(fixture.timeframes["1w"]!),
};
const series = buildSwingSeries(candles);
const last = candles.h4.length - 1;

const at = (pts: { time: number; value: number }[], time: number) => pts.find((p) => p.time === time)?.value ?? null;

/** Only what was known at bar k's close: 4h bars 0..k and the HTF bars closed by then. */
function knownAt(k: number): SwingCandles {
  const t = candles.h4[k]!.time + H4;
  return {
    h4: candles.h4.slice(0, k + 1),
    d1: candles.d1.filter((c: Candle) => c.time + D1 <= t),
    w1: candles.w1.filter((c: Candle) => c.time + W1 <= t),
  };
}

describe("swing series on the BTC-USD fixture", () => {
  it("takes the 4h values from the shared indicators", () => {
    const s = snapshotAt(series, last);
    const t = candles.h4[last]!.time;
    expect(s.barTime).toBe(t);
    expect(s.closeTime).toBe(t + H4);
    expect(s.close).toBe(candles.h4[last]!.close);
    expect(s.ema20).toBe(at(computeEMA(candles.h4, 20), t));
    expect(s.ema50).toBe(at(computeEMA(candles.h4, 50), t));
    expect(s.rsi14).toBe(at(computeRSI(candles.h4, 14), t));
    expect(s.atr14).toBe(at(computePineATR(candles.h4, 14), t));
    const adx = computeADX(candles.h4, { diLength: 14, adxSmoothing: 14 });
    expect(s.adx).toBe(at(adx.adx, t));
    expect(s.plusDI).toBe(at(adx.plusDI, t));
    expect(s.minusDI).toBe(at(adx.minusDI, t));
    expect(s.utStop).toBe(at(computeUTBot(candles.h4, { keyValue: 1, atrPeriod: 10 }).stop, t));
    const day = prevPeriodLevelSeries(candles.h4, { candleSec: H4, period: "day" });
    const week = prevPeriodLevelSeries(candles.h4, { candleSec: H4, period: "week" });
    expect(s.pdh).toBe(at(day.high, t));
    expect(s.pdl).toBe(at(day.low, t));
    expect(s.pwh).toBe(at(week.high, t));
    expect(s.pwl).toBe(at(week.low, t));
    expect(s.window.map((b) => b.time)).toEqual([t - 2 * H4, t - H4, t]);
  });

  it("takes weekly/daily values from the last CLOSED weekly/daily bar", () => {
    const s = snapshotAt(series, last);
    const t = s.closeTime;
    const w = [...candles.w1].reverse().find((c) => c.time + W1 <= t)!;
    const d = [...candles.d1].reverse().find((c) => c.time + D1 <= t)!;
    expect(s.weekly).toEqual({
      barTime: w.time,
      close: w.close,
      sma50: at(computeSMA(candles.w1, 50), w.time),
      sma200: at(computeSMA(candles.w1, 200), w.time),
    });
    expect(s.daily).toEqual({ barTime: d.time, close: d.close, sma200: at(computeSMA(candles.d1, 200), d.time) });
  });

  it("keeps at most 5 levels per side per timeframe, all active and on the right side of the close", () => {
    for (const k of [300, 800, last]) {
      const s = snapshotAt(series, k);
      for (const tf of ["4h", "1d"] as const) {
        const sup = s.levels.filter((l) => l.tf === tf && l.role === "support");
        const res = s.levels.filter((l) => l.tf === tf && l.role === "resistance");
        expect(sup.length).toBeLessThanOrEqual(5);
        expect(res.length).toBeLessThanOrEqual(5);
        for (const l of sup) expect(l.bottom).toBeLessThan(s.close);
        for (const l of res) expect(l.top).toBeGreaterThan(s.close);
      }
    }
    expect(snapshotAt(series, last).levels.some((l) => l.tf === "1d")).toBe(true);
  });

  it("has no lookahead: the snapshot at k equals one built only from data known at k's close", () => {
    const ks = [0, 1, 2, 30, 61, 120, 250, 499, 777, 1000, 1234, last - 1, last];
    for (const k of ks) {
      expect(snapshotAt(buildSwingSeries(knownAt(k)), k)).toEqual(snapshotAt(series, k));
    }
  });

  it("is warm-up at the first bars and never throws over the whole fixture", () => {
    const acct: SwingAccount = {
      equity: 100_000, peakEquity: 100_000, dayStartEquity: 100_000, entriesToday: 0,
      killed: false, position: null, lastExitTime: null,
    };
    expect(evaluateSwing(snapshotAt(series, 0), acct, "A", { takerFeeBps: 5, slippageBps: 5 }).reasonCode).toBe("warmup");
    for (const variant of ["A", "B"] as const) {
      for (let k = 0; k <= last; k++) {
        const d = evaluateSwing(snapshotAt(series, k), acct, variant, { takerFeeBps: 5, slippageBps: 5 });
        expect(SWING_REASON_CODES).toContain(d.reasonCode);
        if (d.plan) {
          const p = d.plan;
          const long = d.action === "ENTER_LONG";
          expect(long ? p.stop < p.entryRef && p.target > p.entryRef : p.stop > p.entryRef && p.target < p.entryRef).toBe(true);
          expect(p.targetR).toBeGreaterThanOrEqual(1.5 - 1e-9);
          expect(p.qty).toBeGreaterThan(0);
          expect(p.notional).toBeLessThanOrEqual(acct.equity + 1e-6);
        }
      }
    }
  });
});
