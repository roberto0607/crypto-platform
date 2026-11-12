import type { Candle } from "./types";
import { computePineATR } from "./pineAtr";
import { findSwingPoints } from "./swings";

/**
 * Support & resistance levels from CONFIRMED swing highs/lows.
 *
 * One forward pass over closed candles. On bar k, using only bars 0..k:
 *   1. every active level known before k is tested for a break on bar k's
 *      close (a broken level that never flipped gets a flipped twin);
 *   2. active levels older than `maxAge` bars are flagged stale (display only);
 *   3. pivots whose confirmation bar is k (pivot + `right`) are merged into an
 *      active level or start a new one.
 * "ATR" is `computePineATR(atrPeriod)` at bar k. Pivots that confirm before
 * the first ATR value are skipped (WARMUP.supportResistance).
 *
 * Rules (numbers are the defaults, SR_DEFAULTS):
 * - A swing high starts a resistance, a swing low a support. The level's
 *   `price` (anchor) is that pivot's price and never moves.
 * - Merge: a confirming pivot joins the nearest active level whose anchor is
 *   within mergeAtr (0.5) × ATR, if the zone (min..max of member pivot prices)
 *   stays within maxZoneAtr (1.5) × ATR once widened; otherwise it starts a
 *   new level. Touches = member pivots.
 * - Break: a resistance breaks when a close is above zone top + breakAtr
 *   (0.25) × ATR; a support when a close is below zone bottom − that. With
 *   the volume filter on, the bar's volume must also exceed volumeMult (1.5) ×
 *   the average volume of the `volumeLookback` (20) bars before it (no break
 *   while fewer bars exist).
 * - Flip: a broken level that is not itself a flip starts a level with the
 *   opposite role at the same anchor/zone/touches, created on the break bar.
 *   A flipped level that breaks is just broken.
 * - Age: bars since the level was created (the pivot bar; the break bar for a
 *   flip). With maxAge > 0, an active level older than maxAge bars is stale.
 *
 * Nothing repaints: the result on candles[0..k] equals
 * `srLevelsAsOf(resultOnAllCandles, k)` for every k.
 */

export interface SRParams {
  left: number;
  right: number;
  atrPeriod: number;
  mergeAtr: number;
  breakAtr: number;
  maxZoneAtr: number;
  volumeFilter: boolean;
  volumeMult: number;
  volumeLookback: number;
  /** 0 = off. */
  maxAge: number;
}

export const SR_DEFAULTS: Readonly<SRParams> = {
  left: 10,
  right: 10,
  atrPeriod: 14,
  mergeAtr: 0.5,
  breakAtr: 0.25,
  maxZoneAtr: 1.5,
  volumeFilter: false,
  volumeMult: 1.5,
  volumeLookback: 20,
  maxAge: 0,
};

export type SRRole = "support" | "resistance";

/** One pivot merged into a level. */
export interface SRTouch {
  index: number;
  time: number;
  confirmedIndex: number;
  confirmedTime: number;
  price: number;
}

export interface SRLevel {
  /** "H<pivot index>" / "L<pivot index>"; a flip appends "f". */
  id: string;
  role: SRRole;
  origin: "swingHigh" | "swingLow";
  flippedFrom: string | null;
  /** Anchor: the first pivot's price. */
  price: number;
  /** Zone = min..max of the touches' prices. */
  top: number;
  bottom: number;
  touches: SRTouch[];
  /** The pivot bar (a flip: the break bar). */
  createdIndex: number;
  createdTime: number;
  /** First bar whose close knows the level (pivot + right; a flip: the break bar). */
  confirmedIndex: number;
  confirmedTime: number;
  brokenIndex: number | null;
  brokenTime: number | null;
  /** Bars since creation, at the break bar or at the last bar. */
  ageBars: number;
  /** First bar the level was active and older than maxAge bars; null if never (or maxAge off). */
  staleIndex: number | null;
  staleTime: number | null;
}

export function computeSupportResistance(candles: Candle[], opts: Partial<SRParams> = {}): SRLevel[] {
  const p: SRParams = { ...SR_DEFAULTS, ...opts };
  const n = candles.length;
  const levels: SRLevel[] = [];
  if (n === 0) return levels;

  const atrPts = computePineATR(candles, p.atrPeriod);
  const atrStart = n - atrPts.length;
  const atrAt = (k: number): number | null => (k >= atrStart ? atrPts[k - atrStart]!.value : null);

  const { highs, lows } = findSwingPoints(candles, { left: p.left, right: p.right });
  type Pivot = { index: number; price: number; origin: SRLevel["origin"] };
  const byConfirm = new Map<number, Pivot[]>();
  // Ascending pivot index, highs before lows on the same bar.
  const pivots: Pivot[] = [
    ...highs.map((s) => ({ index: s.index, price: s.price, origin: "swingHigh" as const })),
    ...lows.map((s) => ({ index: s.index, price: s.price, origin: "swingLow" as const })),
  ].sort((a, b) => a.index - b.index || (a.origin === b.origin ? 0 : a.origin === "swingHigh" ? -1 : 1));
  for (const pv of pivots) {
    const k = pv.index + p.right;
    const list = byConfirm.get(k);
    if (list) list.push(pv);
    else byConfirm.set(k, [pv]);
  }

  const active: SRLevel[] = [];
  let volSum = 0;

  for (let k = 0; k < n; k++) {
    const c = candles[k]!;
    const atr = atrAt(k);

    // 1. Breaks (levels known before this bar).
    if (atr !== null) {
      const volOk = !p.volumeFilter
        || (k >= p.volumeLookback && c.volume > p.volumeMult * (volSum / p.volumeLookback));
      for (let i = 0; i < active.length; i++) {
        const lv = active[i]!;
        if (lv.confirmedIndex >= k) continue;
        const buffer = p.breakAtr * atr;
        const broke = lv.role === "resistance" ? c.close > lv.top + buffer : c.close < lv.bottom - buffer;
        if (!broke || !volOk) continue;
        lv.brokenIndex = k;
        lv.brokenTime = c.time;
        lv.ageBars = k - lv.createdIndex;
        active.splice(i--, 1);
        if (lv.flippedFrom === null) {
          const flip: SRLevel = {
            ...lv,
            id: `${lv.id}f`,
            role: lv.role === "resistance" ? "support" : "resistance",
            flippedFrom: lv.id,
            touches: lv.touches.map((t) => ({ ...t })),
            createdIndex: k,
            createdTime: c.time,
            confirmedIndex: k,
            confirmedTime: c.time,
            brokenIndex: null,
            brokenTime: null,
            ageBars: 0,
            staleIndex: null,
            staleTime: null,
          };
          levels.push(flip);
          active.push(flip);
        }
      }
    }

    // 2. Stale flag.
    if (p.maxAge > 0) {
      for (const lv of active) {
        if (lv.staleIndex === null && k - lv.createdIndex > p.maxAge) {
          lv.staleIndex = k;
          lv.staleTime = c.time;
        }
      }
    }

    // 3. Pivots confirmed by this bar.
    const confirming = byConfirm.get(k);
    if (confirming && atr !== null) {
      for (const pv of confirming) {
        const touch: SRTouch = {
          index: pv.index,
          time: candles[pv.index]!.time,
          confirmedIndex: k,
          confirmedTime: c.time,
          price: pv.price,
        };
        let best: SRLevel | null = null;
        for (const lv of active) {
          const d = Math.abs(pv.price - lv.price);
          if (d <= p.mergeAtr * atr && (best === null || d < Math.abs(pv.price - best.price))) best = lv;
        }
        if (best && Math.max(best.top, pv.price) - Math.min(best.bottom, pv.price) <= p.maxZoneAtr * atr) {
          best.touches.push(touch);
          best.top = Math.max(best.top, pv.price);
          best.bottom = Math.min(best.bottom, pv.price);
          continue;
        }
        const lv: SRLevel = {
          id: `${pv.origin === "swingHigh" ? "H" : "L"}${pv.index}`,
          role: pv.origin === "swingHigh" ? "resistance" : "support",
          origin: pv.origin,
          flippedFrom: null,
          price: pv.price,
          top: pv.price,
          bottom: pv.price,
          touches: [touch],
          createdIndex: pv.index,
          createdTime: touch.time,
          confirmedIndex: k,
          confirmedTime: c.time,
          brokenIndex: null,
          brokenTime: null,
          ageBars: 0,
          staleIndex: null,
          staleTime: null,
        };
        levels.push(lv);
        active.push(lv);
      }
    }

    volSum += c.volume;
    if (k >= p.volumeLookback) volSum -= candles[k - p.volumeLookback]!.volume;
  }

  for (const lv of active) lv.ageBars = n - 1 - lv.createdIndex;
  return levels;
}

/**
 * How late a pivot (so a level, a touch) becomes known: `right` bars after
 * the pivot bar, i.e. at that bar's close. For the settings panel ("confirms
 * after 40h" on 4h with right = 10); the same holds for HTF levels with their
 * own `right` and timeframe.
 */
export function srConfirmationDelay(right: number, timeframeSec: number): { bars: number; seconds: number } {
  return { bars: right, seconds: right * timeframeSec };
}

/**
 * The levels as they stood at the close of bar `index` (of the candles they
 * were computed on): only levels confirmed by then, only touches confirmed by
 * then (zone recomputed from them), a later break/stale flag erased and the
 * age taken at `index` (or at the break). Equal to computing on
 * candles[0..index].
 */
export function srLevelsAsOf(levels: SRLevel[], index: number): SRLevel[] {
  const out: SRLevel[] = [];
  for (const lv of levels) {
    if (lv.confirmedIndex > index) continue;
    const touches = lv.touches.filter((t) => t.confirmedIndex <= index).map((t) => ({ ...t }));
    const broken = lv.brokenIndex !== null && lv.brokenIndex <= index;
    const stale = lv.staleIndex !== null && lv.staleIndex <= index;
    out.push({
      ...lv,
      touches,
      top: Math.max(...touches.map((t) => t.price)),
      bottom: Math.min(...touches.map((t) => t.price)),
      brokenIndex: broken ? lv.brokenIndex : null,
      brokenTime: broken ? lv.brokenTime : null,
      ageBars: (broken ? lv.brokenIndex! : index) - lv.createdIndex,
      staleIndex: stale ? lv.staleIndex : null,
      staleTime: stale ? lv.staleTime : null,
    });
  }
  return out;
}

/** The unbroken levels at the close of bar `index` — what a backtest may act on there. */
export function activeSRLevelsAt(levels: SRLevel[], index: number): SRLevel[] {
  return srLevelsAsOf(levels, index).filter((lv) => lv.brokenIndex === null);
}

/**
 * Higher-timeframe levels at instant `t` on a lower timeframe, by the HTF rule
 * (htf.ts): only HTF bars that had CLOSED by `t` (open + htfSec <= t) count,
 * so a level appears, gains a touch, breaks or goes stale when the HTF bar
 * that did it closes. `htfTimes` = the open times of the candles the levels
 * were computed on, ascending.
 */
export function srHtfLevelsAt(levels: SRLevel[], htfTimes: readonly number[], htfSec: number, t: number): SRLevel[] {
  let lo = 0;
  let hi = htfTimes.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (htfTimes[mid]! + htfSec <= t) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found < 0 ? [] : srLevelsAsOf(levels, found);
}
