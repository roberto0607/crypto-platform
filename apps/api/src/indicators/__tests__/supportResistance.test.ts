/**
 * Support & resistance levels (shared source, API copy): hand-worked rule
 * cases on synthetic candles, then no-lookahead and rule properties on the
 * real BTC-USD fixture.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  computeSupportResistance, srConfirmationDelay, srLevelsAsOf, activeSRLevelsAt, srHtfLevelsAt, computePineATR, WARMUP, SR_DEFAULTS,
  fixtureCandles, type Candle, type CandleFixture, type SRLevel, type SRParams,
} from "../shared";
import * as shared from "../shared";
import * as publicApi from "../index";

const fixture = JSON.parse(
  readFileSync(new URL("../../../../../packages/indicators/fixtures/btcusd-coinbase.json", import.meta.url), "utf8"),
) as CandleFixture;
const h4 = fixtureCandles(fixture.timeframes["4h"]!);
const d1 = fixtureCandles(fixture.timeframes["1d"]!);

/**
 * Bars around a mid price: high = mid + 1, low = mid − 1, close = mid. With
 * mids moving at most 1 per bar every true range is 2, so ATR(3) = 2 exactly
 * from bar 2 on.
 */
function bars(mids: number[], volumes?: number[]): Candle[] {
  return mids.map((m, i) => ({ time: i * 3600, open: m, high: m + 1, low: m - 1, close: m, volume: volumes?.[i] ?? 100 }));
}
const small: Partial<SRParams> = { left: 2, right: 2, atrPeriod: 3 };
const byId = (levels: SRLevel[]) => Object.fromEntries(levels.map((l) => [l.id, l]));

// Two equal peaks (bars 4 and 9, high 13), a rally that closes 14 on bar 16
// (> 13 + 0.25 × 2), a peak at bar 17 (high 16), then a drop to close 12 on bar 20.
const A = [10, 10, 10, 11, 12, 11, 10, 10, 11, 12, 11, 10, 10, 11, 12, 13, 14, 15, 14, 13, 12];

describe("computeSupportResistance rules (synthetic)", () => {
  it("levels come only from confirmed pivots: created at the pivot, known `right` bars later", () => {
    const lv = byId(computeSupportResistance(bars(A), small));
    expect(Object.keys(lv)).toEqual(["H4", "H4f", "H17"]);
    expect(lv.H4).toMatchObject({ role: "resistance", origin: "swingHigh", price: 13, createdIndex: 4, confirmedIndex: 6, confirmedTime: 6 * 3600 });
    expect(lv.H17).toMatchObject({ role: "resistance", price: 16, createdIndex: 17, confirmedIndex: 19, brokenIndex: null, ageBars: 3 });
    // Nothing before bar 6 knows about H4.
    expect(computeSupportResistance(bars(A.slice(0, 6)), small)).toEqual([]);
  });

  it("merges a pivot within 0.5 × ATR into the level: touches = merged pivots, zone = their range", () => {
    const { H4 } = byId(computeSupportResistance(bars(A), small));
    expect(H4!.touches.map((t) => [t.index, t.confirmedIndex, t.price])).toEqual([[4, 6, 13], [9, 11, 13]]);
    expect([H4!.top, H4!.bottom]).toEqual([13, 13]);
  });

  it("breaks on the first close beyond the zone by 0.25 × ATR, and flips the role once", () => {
    const { H4, H4f } = byId(computeSupportResistance(bars(A), small));
    expect(H4).toMatchObject({ brokenIndex: 16, brokenTime: 16 * 3600, ageBars: 12 });
    expect(H4f).toMatchObject({
      role: "support", origin: "swingHigh", flippedFrom: "H4", price: 13, top: 13, bottom: 13,
      createdIndex: 16, confirmedIndex: 16, brokenIndex: 20, ageBars: 4,
    });
    expect(H4f!.touches).toHaveLength(2);
  });

  it("a close beyond the zone but within the buffer is not a break", () => {
    // Buffer 0.5 × 2 = 1 → needs a close above 14: bar 16 (14) holds, bar 17 (15) breaks.
    expect(byId(computeSupportResistance(bars(A), { ...small, breakAtr: 0.5 })).H4!.brokenIndex).toBe(17);
    // Buffer 2 → needs a close above 15: never.
    const lv = byId(computeSupportResistance(bars(A), { ...small, breakAtr: 1 }));
    expect(lv.H4!.brokenIndex).toBeNull();
    expect(lv.H4f).toBeUndefined();
  });

  it("volume filter: a break needs volume above volumeMult × the average of the bars before it", () => {
    const vols = A.map((_, i) => (i === 17 ? 400 : 100));
    const opts = { ...small, volumeFilter: true, volumeMult: 1.5, volumeLookback: 5 };
    const lv = byId(computeSupportResistance(bars(A, vols), opts));
    expect(lv.H4!.brokenIndex).toBe(17); // bar 16 closed beyond on average volume
    expect(lv.H4f).toMatchObject({ createdIndex: 17, brokenIndex: null }); // bar 20 closed below on average volume
    // Fewer than volumeLookback bars before it → no break.
    expect(byId(computeSupportResistance(bars(A, vols), { ...opts, volumeLookback: 18 })).H4!.brokenIndex).toBeNull();
  });

  it("a pivot that would widen the zone beyond maxZoneAtr × ATR starts a new level", () => {
    // Peaks at bar 4 (high 13) and bar 9 (high 14): 1 apart = 0.5 × ATR.
    const B = [10, 10, 10, 11, 12, 11, 10, 11, 12, 13, 12, 11, 10, 10, 10];
    const merged = byId(computeSupportResistance(bars(B), small));
    expect(merged.H4).toMatchObject({ price: 13, top: 14, bottom: 13 });
    expect(merged.H9).toBeUndefined();
    const capped = byId(computeSupportResistance(bars(B), { ...small, mergeAtr: 1, maxZoneAtr: 0.25 }));
    expect(capped.H4).toMatchObject({ top: 13, bottom: 13 });
    expect(capped.H9).toMatchObject({ price: 14, top: 14, bottom: 14 });
    expect(capped.H9!.touches).toHaveLength(1);
    // A pivot beyond the merge distance starts its own level too.
    expect(byId(computeSupportResistance(bars(B), { ...small, mergeAtr: 0.25 })).H9).toBeDefined();
  });

  it("maxAge flags an active level older than N bars as stale (off by default); age is in the output", () => {
    const lv = byId(computeSupportResistance(bars(A), { ...small, maxAge: 5 }));
    expect(lv.H4).toMatchObject({ staleIndex: 10, staleTime: 10 * 3600 });
    expect(lv.H4f!.staleIndex).toBeNull();
    expect(lv.H17!.staleIndex).toBeNull();
    for (const l of computeSupportResistance(bars(A), small)) expect(l.staleIndex).toBeNull();
  });

  it("as-of views: active levels at a bar, with the age at that bar", () => {
    const levels = computeSupportResistance(bars(A), { ...small, maxAge: 5 });
    expect(activeSRLevelsAt(levels, 5)).toEqual([]);
    const at11 = activeSRLevelsAt(levels, 11);
    expect(at11.map((l) => [l.id, l.touches.length, l.ageBars, l.staleIndex])).toEqual([["H4", 2, 7, 10]]);
    expect(activeSRLevelsAt(levels, 10).map((l) => [l.id, l.touches.length])).toEqual([["H4", 1]]);
    expect(activeSRLevelsAt(levels, 16).map((l) => l.id)).toEqual(["H4f"]);
    expect(activeSRLevelsAt(levels, 20).map((l) => l.id)).toEqual(["H17"]);
  });

  it("empty and short inputs", () => {
    expect(computeSupportResistance([])).toEqual([]);
    expect(computeSupportResistance(bars([1, 2, 3]))).toEqual([]);
  });
});

describe("computeSupportResistance on 4h / 1d BTC-USD", () => {
  it("never looks ahead: computing on candles[0..k] equals srLevelsAsOf(all, k) for every k", () => {
    for (const [candles, opts] of [
      [h4, {}],
      [d1, {}],
      [h4, { left: 5, right: 5, volumeFilter: true, maxAge: 60 }],
    ] as const) {
      const all = computeSupportResistance(candles as Candle[], opts);
      const step = Math.max(1, Math.floor(candles.length / 150));
      for (let k = 0; k < candles.length; k += step) {
        expect(computeSupportResistance(candles.slice(0, k + 1) as Candle[], opts), `k=${k}`).toEqual(srLevelsAsOf(all, k));
      }
      expect(computeSupportResistance(candles as Candle[], opts)).toEqual(srLevelsAsOf(all, candles.length - 1));
    }
  });

  it("follows the rules on every level", () => {
    const p = { ...SR_DEFAULTS };
    const levels = computeSupportResistance(h4);
    const atr = computePineATR(h4, p.atrPeriod);
    const atrAt = (k: number) => atr[k - (h4.length - atr.length)]!.value;
    const ids = byId(levels);
    expect(levels.length).toBeGreaterThan(20);
    expect(levels.filter((l) => l.brokenIndex !== null).length).toBeGreaterThan(10);
    expect(levels.filter((l) => l.flippedFrom !== null).length).toBeGreaterThan(5);
    expect(levels.some((l) => l.touches.length >= 2)).toBe(true);

    for (const l of levels) {
      for (const t of l.touches) expect(t.confirmedIndex).toBe(t.index + p.right);
      if (l.flippedFrom === null) {
        expect(l.confirmedIndex).toBe(l.createdIndex + p.right);
        expect(l.role).toBe(l.origin === "swingHigh" ? "resistance" : "support");
      } else {
        const parent = ids[l.flippedFrom]!;
        expect(parent.flippedFrom).toBeNull();
        expect(parent.brokenIndex).toBe(l.createdIndex);
        expect(l.role).not.toBe(parent.role);
      }
      // Extends until the first close beyond the zone (as it stood) by 0.25 × ATR.
      const end = l.brokenIndex ?? h4.length;
      for (let k = l.confirmedIndex + 1; k <= Math.min(end, h4.length - 1); k++) {
        const z = srLevelsAsOf([l], k - 1)[0]!;
        const buf = p.breakAtr * atrAt(k);
        const beyond = l.role === "resistance" ? h4[k]!.close > z.top + buf : h4[k]!.close < z.bottom - buf;
        expect(beyond, `${l.id} bar ${k}`).toBe(k === l.brokenIndex);
      }
      expect(l.top - l.bottom).toBeGreaterThanOrEqual(0);
      expect(l.ageBars).toBe((l.brokenIndex ?? h4.length - 1) - l.createdIndex);
    }
  });
});

describe("srHtfLevelsAt", () => {
  it("a daily level shows on a lower timeframe only once the daily bar that confirmed (or broke) it has closed", () => {
    const levels = computeSupportResistance(d1);
    const times = d1.map((c) => c.time);
    const lv = levels.find((l) => l.brokenIndex !== null && l.flippedFrom === null)!;
    const confirmClose = times[lv.confirmedIndex]! + 86_400;
    expect(srHtfLevelsAt(levels, times, 86_400, confirmClose - 1).some((l) => l.id === lv.id)).toBe(false);
    expect(srHtfLevelsAt(levels, times, 86_400, confirmClose).find((l) => l.id === lv.id)?.brokenIndex).toBeNull();
    const breakClose = lv.brokenTime! + 86_400;
    expect(srHtfLevelsAt(levels, times, 86_400, breakClose - 1).find((l) => l.id === lv.id)?.brokenIndex).toBeNull();
    expect(srHtfLevelsAt(levels, times, 86_400, breakClose).find((l) => l.id === lv.id)?.brokenIndex).toBe(lv.brokenIndex);
    expect(srHtfLevelsAt(levels, times, 86_400, times[0]!)).toEqual([]);
  });
});

describe("support/resistance exports", () => {
  it("warm-up: first bar that can hold a level", () => {
    expect(WARMUP.supportResistance()).toBe(20);
    expect(WARMUP.supportResistance(2, 2, 14)).toBe(13);
  });

  it("confirmation delay: a pivot is known `right` bars after it (for the settings panel)", () => {
    expect(srConfirmationDelay(10, 14_400)).toEqual({ bars: 10, seconds: 144_000 }); // 4h: 40h
    expect(srConfirmationDelay(10, 86_400)).toEqual({ bars: 10, seconds: 864_000 }); // 1D: 10 days
    expect(srConfirmationDelay(5, 604_800)).toEqual({ bars: 5, seconds: 3_024_000 }); // 1W HTF: 5 weeks
  });

  it("the API exports the shared implementation", () => {
    for (const name of ["computeSupportResistance", "srConfirmationDelay", "srLevelsAsOf", "activeSRLevelsAt", "srHtfLevelsAt"] as const) {
      expect(publicApi[name]).toBe(shared[name]);
    }
  });
});
