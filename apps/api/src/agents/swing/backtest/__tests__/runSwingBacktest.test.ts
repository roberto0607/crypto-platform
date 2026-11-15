/**
 * The backtest wiring on the real BTC-USD fixture (4h/1d/1w, no 1h, so fills
 * walk the 4h bar): common start, ADX >= 25 sensitivity, daily-ADX regime,
 * and no lookahead for the whole run (cutting the data at bar m changes
 * nothing before m).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fixtureCandles, type Candle, type CandleFixture } from "../../../../indicators/shared";
import { evaluateSwing } from "../../evaluateSwing";
import { buildSwingSeries, snapshotAt } from "../../swingSeries";
import { firstEvaluableIndex, regimeOf, runSwingBacktest, type BacktestCandles } from "../runSwingBacktest";

const H4 = 14_400;
const fixture = JSON.parse(
  readFileSync(new URL("../../../../../../../packages/indicators/fixtures/btcusd-coinbase.json", import.meta.url), "utf8"),
) as CandleFixture;
const candles: BacktestCandles = {
  h1: [],
  h4: fixtureCandles(fixture.timeframes["4h"]!),
  d1: fixtureCandles(fixture.timeframes["1d"]!),
  w1: fixtureCandles(fixture.timeframes["1w"]!),
};
const COSTS = { takerFeeBps: 5, slippageBps: 5 };
const FLAT = { equity: 1e5, peakEquity: 1e5, dayStartEquity: 1e5, entriesToday: 0, killed: false, position: null, lastExitTime: null };

describe("runSwingBacktest", () => {
  const series = buildSwingSeries(candles);
  const start = firstEvaluableIndex(series);

  it("starts at the first bar where neither variant is in warm-up", () => {
    for (const v of ["A", "B"] as const) {
      expect(evaluateSwing(snapshotAt(series, start), FLAT, v, COSTS).reasonCode).not.toBe("warmup");
    }
    const before = (["A", "B"] as const).map((v) => evaluateSwing(snapshotAt(series, start - 1), FLAT, v, COSTS).reasonCode);
    expect(before).toContain("warmup");
  });

  it("runs both variants from that bar with no warm-up decisions", () => {
    for (const variant of ["A", "B"] as const) {
      const r = runSwingBacktest({ candles, variant, costs: COSTS, startEquity: 100_000 });
      expect(r.startIndex).toBe(start);
      expect(r.sim.equity[0]!.time).toBe(candles.h4[start]!.time + H4);
      expect(r.sim.reasonCounts.warmup ?? 0).toBe(0);
      for (const t of r.trades) expect(["trending", "transitional", "ranging", "unknown"]).toContain(t.regime);
    }
  });

  it("ADX >= 25 sensitivity only removes entries", () => {
    const base = runSwingBacktest({ candles, variant: "B", costs: COSTS, startEquity: 100_000 });
    const strict = runSwingBacktest({ candles, variant: "B", costs: COSTS, startEquity: 100_000, adxMin: 25 });
    for (const t of strict.trades) expect(t.adx).toBeGreaterThanOrEqual(25);
    expect(strict.sim.reasonCounts.entry ?? 0).toBeLessThanOrEqual(base.sim.reasonCounts.entry ?? 0);
  });

  it("regime by daily ADX 14: >= 25 trending, < 20 ranging, else transitional", () => {
    expect(regimeOf(25)).toBe("trending");
    expect(regimeOf(24.99)).toBe("transitional");
    expect(regimeOf(20)).toBe("transitional");
    expect(regimeOf(19.99)).toBe("ranging");
    expect(regimeOf(null)).toBe("unknown");
  });

  it("has no lookahead: a run on data cut at bar m equals the full run before m", () => {
    for (const variant of ["A", "B"] as const) {
      const full = runSwingBacktest({ candles, variant, costs: COSTS, startEquity: 100_000 });
      for (const m of [start + 200, start + 600, candles.h4.length - 40]) {
        const cutClose = candles.h4[m]!.time + H4;
        const known = (cs: Candle[], sec: number) => cs.filter((c) => c.time + sec <= cutClose);
        const cut = runSwingBacktest({
          candles: { h1: [], h4: candles.h4.slice(0, m + 1), d1: known(candles.d1, 86_400), w1: known(candles.w1, 604_800) },
          variant, costs: COSTS, startEquity: 100_000,
        });
        // Every decision through bar m (the cut's last bar) read the same bar and did the same thing.
        expect(cut.sim.decisions).toEqual(full.sim.decisions.slice(0, cut.sim.decisions.length));
        expect(cut.sim.decisions.at(-1)!.barTime).toBe(candles.h4[m]!.time);
        // Equity at every close before m, and every trade closed before m's open, are identical.
        const before = (e: { time: number }) => e.time < cutClose;
        expect(cut.sim.equity.filter(before)).toEqual(full.sim.equity.filter(before));
        const closed = (t: { exitTime: number }) => t.exitTime <= candles.h4[m]!.time;
        expect(cut.trades.filter(closed)).toEqual(full.trades.filter(closed));
      }
    }
  });
});
