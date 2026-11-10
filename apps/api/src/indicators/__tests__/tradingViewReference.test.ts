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
  type CandleFixture, type Point,
} from "../shared";

const dir = new URL("../../../../../packages/indicators/fixtures/", import.meta.url);
const fixture = JSON.parse(readFileSync(new URL("btcusd-coinbase.json", dir), "utf8")) as CandleFixture;
const tv = JSON.parse(readFileSync(new URL("tradingview-reference.json", dir), "utf8")) as {
  timeframes: Record<string, { window: [number, number]; signals: [number, 1 | -1][]; rows: number[][] }>;
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
