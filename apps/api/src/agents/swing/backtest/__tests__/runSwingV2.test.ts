/**
 * v2 wiring on the real BTC-USD fixture (4h/1d/1w, no 1h): a period run
 * reads nothing at or after its end, has no lookahead, only exits on the
 * stop, the EMA 50 close or the period end, and records the room samples.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fixtureCandles, type Candle, type CandleFixture } from "../../../../indicators/shared";
import { evaluateSwingV2 } from "../../evaluateSwingV2";
import { buildSwingSeries, snapshotAt } from "../../swingSeries";
import type { BacktestCandles } from "../runSwingBacktest";
import { indexAtOrAfter, runSwingV2 } from "../runSwingV2";

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

describe("runSwingV2", () => {
  const series = buildSwingSeries(candles);
  let start = 0;
  while (start < candles.h4.length && evaluateSwingV2(snapshotAt(series, start), FLAT, COSTS).reasonCode === "warmup") start++;
  const end = candles.h4.length;

  it("indexAtOrAfter finds the first bar at or after a time", () => {
    expect(indexAtOrAfter(candles.h4, candles.h4[10]!.time)).toBe(10);
    expect(indexAtOrAfter(candles.h4, candles.h4[10]!.time + 1)).toBe(11);
    expect(indexAtOrAfter(candles.h4, 0)).toBe(0);
    expect(indexAtOrAfter(candles.h4, Number.MAX_SAFE_INTEGER)).toBe(candles.h4.length);
  });

  it("runs with no warm-up decisions and exits only on stop / trend / end_of_data", () => {
    const r = runSwingV2({ candles, costs: COSTS, startEquity: 100_000, startIndex: start, endIndex: end, series });
    expect(r.sim.reasonCounts.warmup ?? 0).toBe(0);
    expect(r.trades.length).toBeGreaterThan(0);
    expect(r.room.length).toBeGreaterThan(0);
    for (const t of r.trades) {
      expect(["stop", "trend", "end_of_data"]).toContain(t.exitReason);
      expect(t.target).toBeNull();
    }
    for (const x of r.room) expect(x.roomR === "none" || x.roomR >= 0).toBe(true);
  });

  it("a period ending at endIndex equals the full run cut there (no bar at or after endIndex is read)", () => {
    const mid = start + Math.floor((end - start) / 2);
    const full = runSwingV2({ candles, costs: COSTS, startEquity: 100_000, startIndex: start, endIndex: end, series });
    const cutClose = candles.h4[mid - 1]!.time + H4;
    const known = (cs: Candle[], sec: number) => cs.filter((c) => c.time + sec <= cutClose);
    const cutCandles = { h1: [], h4: candles.h4.slice(0, mid), d1: known(candles.d1, 86_400), w1: known(candles.w1, 604_800) };
    const period = runSwingV2({ candles, costs: COSTS, startEquity: 100_000, startIndex: start, endIndex: mid, series });
    const cut = runSwingV2({ candles: cutCandles, costs: COSTS, startEquity: 100_000, startIndex: start, endIndex: mid });
    // Built on all data and stopped at mid, or built only on data before mid: the same decisions.
    expect(period.sim.decisions).toEqual(cut.sim.decisions);
    expect(period.trades).toEqual(cut.trades);
    expect(period.sim.decisions).toEqual(full.sim.decisions.slice(0, period.sim.decisions.length));
    expect(period.sim.decisions.at(-1)!.barTime).toBe(candles.h4[mid - 1]!.time);
  });
});
