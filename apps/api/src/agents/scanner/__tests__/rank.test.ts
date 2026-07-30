import { describe, it, expect } from "vitest";
import { rankPairs, type PairDailyStats, type DailyCandle } from "../rank";

function candle(daysAgo: number, overrides: Partial<DailyCandle> = {}): DailyCandle {
  return {
    ts: new Date(Date.UTC(2026, 0, 20 - daysAgo)).toISOString(),
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 1000,
    ...overrides,
  };
}

/** N flat baseline days (open=close=100, high=101, low=99, volume=1000)
 *  followed by one "today" candle with the given overrides. */
function pairWithToday(pairId: string, symbol: string, today: Partial<DailyCandle>, baselineDays = 20): PairDailyStats {
  const candles: DailyCandle[] = [];
  for (let i = baselineDays; i >= 1; i--) candles.push(candle(i));
  candles.push(candle(0, today));
  return { pairId, symbol, candles };
}

describe("rankPairs", () => {
  it("ranks a pair with higher volatility AND volume above one with neither", () => {
    const quiet = pairWithToday("pair-quiet", "QUIET/USD", { high: 100.5, low: 99.5, volume: 1000 });
    const hot = pairWithToday("pair-hot", "HOT/USD", { high: 110, low: 90, volume: 5000 });

    const result = rankPairs([quiet, hot], 2);

    expect(result.map((r) => r.pairId)).toEqual(["pair-hot", "pair-quiet"]);
  });

  it("computes volatilityPct as (high-low)/open * 100 on the latest candle", () => {
    // (110 - 90) / 100 * 100 = 20%
    const pair = pairWithToday("pair-a", "A/USD", { open: 100, high: 110, low: 90 });
    const [result] = rankPairs([pair], 1);
    expect(result!.volatilityPct).toBeCloseTo(20, 10);
  });

  it("computes volumeRatio as today's volume over the average of prior baseline days", () => {
    // 20 baseline days at volume=1000 (avg=1000), today volume=3000 -> ratio 3.0
    const pair = pairWithToday("pair-a", "A/USD", { volume: 3000 });
    const [result] = rankPairs([pair], 1);
    expect(result!.volumeRatio).toBeCloseTo(3, 10);
  });

  it("score is volatilityPct * volumeRatio", () => {
    const pair = pairWithToday("pair-a", "A/USD", { open: 100, high: 110, low: 90, volume: 3000 });
    const [result] = rankPairs([pair], 1);
    // volatilityPct=20, volumeRatio=3 -> score=60
    expect(result!.score).toBeCloseTo(60, 10);
  });

  it("excludes pairs with fewer than 2 candles (no baseline to compare against)", () => {
    const tooFew: PairDailyStats = { pairId: "pair-new", symbol: "NEW/USD", candles: [candle(0)] };
    const normal = pairWithToday("pair-a", "A/USD", {});
    const result = rankPairs([tooFew, normal], 10);
    expect(result.map((r) => r.pairId)).toEqual(["pair-a"]);
  });

  it("caps volumeRatio for a near-zero (but nonzero) baseline instead of letting it blow up", () => {
    const candles: DailyCandle[] = [];
    // 20 baseline days at a near-dead volume of 0.001.
    for (let i = 20; i >= 1; i--) candles.push(candle(i, { volume: 0.001 }));
    // Today: a perfectly normal volume of 1000 -- would be a ratio of
    // 1,000,000 uncapped, which is a data-artifact blowup, not a signal.
    candles.push(candle(0, { volume: 1000 }));
    const pair: PairDailyStats = { pairId: "pair-thin", symbol: "THIN/USD", candles };

    const [result] = rankPairs([pair], 1);
    expect(result!.volumeRatio).toBe(25); // MAX_VOLUME_RATIO
    expect(Number.isFinite(result!.score)).toBe(true);
  });

  it("excludes pairs with a zero/invalid open (guards divide-by-zero)", () => {
    const bad = pairWithToday("pair-bad", "BAD/USD", { open: 0 });
    const normal = pairWithToday("pair-a", "A/USD", {});
    const result = rankPairs([bad, normal], 10);
    expect(result.map((r) => r.pairId)).toEqual(["pair-a"]);
  });

  it("truncates to the requested shortlist size", () => {
    const pairs = Array.from({ length: 10 }, (_, i) =>
      pairWithToday(`pair-${i}`, `P${i}/USD`, { volume: 1000 + i * 100 }),
    );
    const result = rankPairs(pairs, 5);
    expect(result).toHaveLength(5);
  });

  it("defaults to a shortlist of 8 when no size is passed", () => {
    const pairs = Array.from({ length: 10 }, (_, i) => pairWithToday(`pair-${i}`, `P${i}/USD`, {}));
    const result = rankPairs(pairs);
    expect(result).toHaveLength(8);
  });
});
