/**
 * Our indicators vs TradingView (COINBASE:BTCUSD, closed bars), on the
 * committed Coinbase fixture: 20 sampled rows per timeframe and every UT Bot
 * signal in the overlapping window (packages/indicators/fixtures/
 * tradingview-reference.json).
 *
 * Measured over all ~290 overlapping bars per timeframe (PR 1b): SMA and RSI
 * agree to float rounding and UT Bot signals land on exactly the same bars.
 * The looser bounds below are DATA differences between Coinbase's REST candles
 * (our fixture) and TradingView's Coinbase feed, not formula differences —
 * with TradingView's OHLC substituted, ATR/ADX match to ~1e-10:
 *   - 4h 2026-10-09 12:00 open 83169.38 vs 83159.72; 4h 2026-11-05 16:00 low
 *     75540.96 vs 75535.95 → ATR within 3e-4 relative, ADX within 0.03
 *   - 1w 2025-06-02 low 100345.73 vs 100377.01 → same
 *   - 1w close of 2018-03-19 8453.00 vs 8452.96 → SMA 200 off by 1.5e-4 while
 *     that week is in its window
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  computeSMA, computeRSI, computePineATR, computeADX, computeUTBot, fixtureCandles, WARMUP,
  htfStepSeries, TIMEFRAME_SEC,
  type CandleFixture, type Point,
} from "../shared";

const dir = new URL("../../../../../packages/indicators/fixtures/", import.meta.url);
const fixture = JSON.parse(readFileSync(new URL("btcusd-coinbase.json", dir), "utf8")) as CandleFixture;
interface HtfReference { length: number; closes: [number, number][]; sma: [number, number][] }
const tv = JSON.parse(readFileSync(new URL("tradingview-reference.json", dir), "utf8")) as {
  timeframes: Record<string, { window: [number, number]; signals: [number, 1 | -1][]; rows: number[][] }>;
  htf: { window4h: [number, number]; "1d": HtfReference; "1w": HtfReference };
};

/** Per timeframe: [SMA relative, RSI absolute, ATR relative, ADX absolute]. */
const TOL: Record<string, [number, number, number, number]> = {
  "4h": [1e-12, 1e-8, 5e-4, 0.05],
  "1d": [1e-12, 1e-8, 1e-9, 1e-6],
  "1w": [1e-7, 1e-8, 5e-4, 0.05],
};

describe.each(Object.keys(TOL))("TradingView reference, %s", (tf) => {
  const candles = fixtureCandles(fixture.timeframes[tf]!);
  const ref = tv.timeframes[tf]!;
  const at = (pts: Point[]) => new Map(pts.map((p) => [p.time, p.value]));
  const ours = {
    sma20: at(computeSMA(candles, 20)),
    sma50: at(computeSMA(candles, 50)),
    sma200: at(computeSMA(candles, 200)),
    rsi: at(computeRSI(candles, 14).slice(WARMUP.rsi(14))),
    atr: at(computePineATR(candles, 14)),
    adx: at(computeADX(candles).adx),
  };
  const [smaTol, rsiTol, atrTol, adxTol] = TOL[tf]!;
  const close = new Map(candles.map((c) => [c.time, c.close]));

  it.each(ref.rows.map((r) => [new Date(r[0]! * 1000).toISOString().slice(0, 16), r] as const))("%s", (_label, row) => {
    const [time, tvClose, sma20, sma50, sma200, rsi, atr, adx] = row as number[];
    const rel = (a: number | undefined, b: number) => Math.abs(a! - b) / Math.abs(b);
    expect(close.get(time!)).toBe(tvClose);
    expect(rel(ours.sma20.get(time!), sma20!)).toBeLessThanOrEqual(smaTol);
    expect(rel(ours.sma50.get(time!), sma50!)).toBeLessThanOrEqual(smaTol);
    expect(rel(ours.sma200.get(time!), sma200!)).toBeLessThanOrEqual(smaTol);
    expect(Math.abs(ours.rsi.get(time!)! - rsi!)).toBeLessThanOrEqual(rsiTol);
    expect(rel(ours.atr.get(time!), atr!)).toBeLessThanOrEqual(atrTol);
    expect(Math.abs(ours.adx.get(time!)! - adx!)).toBeLessThanOrEqual(adxTol);
  });

  it("UT Bot buy/sell signals land on the same bars as TradingView's", () => {
    const [from, to] = ref.window;
    const signals = computeUTBot(candles).signals
      .filter((s) => s.time >= from && s.time <= to)
      .map((s) => [s.time, s.side === "buy" ? 1 : -1]);
    expect(signals).toEqual(ref.signals);
  });
});

/**
 * Higher timeframe on the 4h chart: the 1D SMA 200 / 1W SMA 50 at each 4h bar
 * must be TradingView's value for the last CLOSED day/week. The expected bar
 * is found here by plain date math (floor to the UTC day / Monday week, minus
 * one), independently of htfStepSeries.
 */
describe.each([["1d", 0], ["1w", 4 * 86_400]] as const)("TradingView reference, %s SMA on 4h bars", (tf, anchor) => {
  const sec = TIMEFRAME_SEC[tf];
  const ref = tv.htf[tf];
  const tvSma = new Map(ref.sma);
  const [from, to] = tv.htf.window4h;
  const times: number[] = [];
  for (let t = from; t <= to; t += TIMEFRAME_SEC["4h"]) times.push(t);
  const lastClosed = (t: number) => Math.floor((t - anchor) / sec) * sec + anchor - sec;
  const rel = (a: number, b: number) => Math.abs(a - b) / Math.abs(b);
  const asCandles = (rows: [number, number][]) => rows.map(([time, close]) => ({ time, open: close, high: close, low: close, close, volume: 0 }));

  it("from TradingView's own closes: every 4h bar, through the last closed bar of the export", () => {
    const step = htfStepSeries(computeSMA(asCandles(ref.closes), ref.length), sec, times);
    expect(step.map((p) => p.time)).toEqual(times);
    const [lastDay, lastSma] = ref.sma.at(-1)!;
    for (const p of step) {
      // TradingView's 1D SMA 200 for 2026-11-09, its last closed day, was
      // computed from a close 1.50 lower than the 75,259.28 it exports for
      // that day (75,257.78 — the next day opened at 75,257.77): 1e-7
      // relative, the same 73,153.80 to the cent. Every other bar: 1e-12.
      const tol = tf === "1d" && lastClosed(p.time) === lastDay ? 2e-7 : 1e-12;
      expect(rel(p.value, tvSma.get(lastClosed(p.time))!)).toBeLessThanOrEqual(tol);
    }
    // The last 4h bar of the export (1D: 2026-11-10 16:00) shows the last closed day's value.
    const last = step.at(-1)!;
    expect(lastClosed(last.time)).toBe(lastDay);
    expect(last.value.toFixed(2)).toBe(lastSma!.toFixed(2));
  });

  it("from our Coinbase fixture: same values wherever the fixture has the closed bar", () => {
    const htf = fixtureCandles(fixture.timeframes[tf]!);
    const covered = times.filter((t) => lastClosed(t) <= htf.at(-1)!.time);
    expect(covered.length).toBeGreaterThan(250);
    const step = htfStepSeries(computeSMA(htf, ref.length), sec, covered);
    expect(step.length).toBe(covered.length);
    for (const p of step) expect(rel(p.value, tvSma.get(lastClosed(p.time))!)).toBeLessThanOrEqual(1e-12);
  });
});
