import { describe, it, expect } from "vitest";
import { syncCoinbaseCandles } from "../featureCandleSync";
import type { OHLCEntry } from "../../../marketData/coinbaseRest";

describe("syncCoinbaseCandles", () => {
  it("pages forward ≤ 300 bars per request over [from, to) and stores only closed bars", async () => {
    const calls: Array<[number, number]> = [];
    const stored: number[] = [];
    const fetchPage = async (_p: string, _g: string, start: number, end: number): Promise<OHLCEntry[]> => {
      calls.push([start, end]);
      const out: OHLCEntry[] = [];
      for (let t = start; t <= end; t += 3_600) out.push({ time: t, open: "1", high: "1", low: "1", close: "1", volume: "1" });
      return out;
    };
    const n = await syncCoinbaseCandles({
      symbol: "BTC-USD", timeframe: "1h", from: 0, to: 700 * 3_600, nowSec: 650 * 3_600 + 10,
      fetchPage, sleepMs: 0,
      store: async (cs) => { stored.push(...cs.map((c) => c.time)); return cs.length; },
    });
    for (const [s, e] of calls) expect((e - s) / 3_600 + 1).toBeLessThanOrEqual(300);
    // bar 649 closes at 650h ≤ now; bar 650 is still forming
    expect(stored[stored.length - 1]).toBe(649 * 3_600);
    expect(new Set(stored).size).toBe(650);
    expect(n).toBe(650);
  });
});
