/**
 * Positioning and sentiment features at a 4h close, from external series.
 * Everything is as of the close instant: only points stamped at or before it
 * (Fear & Greed: at or before the close minus one day).
 *
 * - p_funding_8h      last Deribit 8h rate, at most 2h old.
 * - p_funding_avg_7d  mean of the hourly rates in (close − 7d, close], ≥ 90% of 168 h present.
 * - p_funding_rank_1y share of the prior year's hourly rates below the current one (ties half),
 *                     strictly earlier points, ≥ 90% of 8,760 h present.
 * - p_oi_usd          last OI in USD, at most 2h old.
 * - p_oi_chg_24h/7d   p_oi_usd ÷ OI at (close − 24h / 7d) − 1; that earlier point must be
 *                     within 2h before its target.
 * - s_fng             last Fear & Greed with timestamp ≤ close − 24h, at most 3 days older.
 * - s_fng_chg_7d      s_fng minus the value exactly 7 days before it.
 *
 * A source that wasn't loaded leaves its columns undefined (the writer
 * records "source_not_wired"); a loaded source gives a value or NULL with a
 * reason: warmup (before the series' first point), stale, coverage, gap.
 */
import type { Point } from "../../../indicators/shared";
import type { FeatureValues, NumFeature } from "../featureColumns";
import { downsampleHourly } from "./externalSeriesRepo";

const H = 3_600;
const D = 86_400;
const MAX_AGE = 2 * H;
const FNG_MAX_AGE = 3 * D;
const COVERAGE = 0.9;

export interface ExternalInput {
  funding?: Point[];
  oi?: Point[];
  fng?: Point[];
}

/** Hourly view + time index, built once per backfill / live run. */
export interface PreparedSeries {
  pts: Point[];
  times: Float64Array;
}
export interface PreparedExternal {
  funding?: PreparedSeries;
  oi?: PreparedSeries;
  fng?: PreparedSeries;
}

const prep = (pts: Point[] | undefined): PreparedSeries | undefined => {
  if (!pts) return undefined;
  const hourly = downsampleHourly(pts);
  return { pts: hourly, times: Float64Array.from(hourly.map((p) => p.time)) };
};

export function prepareExternal(input: ExternalInput): PreparedExternal {
  return { funding: prep(input.funding), oi: prep(input.oi), fng: prep(input.fng) };
}

/** Index of the last point with time <= t, or −1. */
function lastAtOrBefore(s: PreparedSeries, t: number): number {
  let lo = 0;
  let hi = s.times.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (s.times[mid]! <= t) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

export function externalFeaturesAt(close: number, ext: PreparedExternal): { values: FeatureValues; missing: Record<string, string> } {
  const values: FeatureValues = {};
  const missing: Record<string, string> = {};
  const set = (name: NumFeature, v: number | null, reason: string) => {
    values[name] = v;
    if (v === null) missing[name] = reason;
  };
  const first = (s: PreparedSeries) => (s.times.length > 0 ? s.times[0]! : Infinity);

  if (ext.funding) {
    const s = ext.funding;
    const i = lastAtOrBefore(s, close);
    const now = i >= 0 && close - s.times[i]! <= MAX_AGE ? s.pts[i]! : null;
    set("p_funding_8h", now?.value ?? null, i < 0 ? "warmup" : "stale");

    const weekStart = close - 7 * D;
    if (weekStart < first(s)) set("p_funding_avg_7d", null, "warmup");
    else {
      let sum = 0;
      let n = 0;
      for (let j = i; j >= 0 && s.times[j]! > weekStart; j--) {
        sum += s.pts[j]!.value;
        n++;
      }
      set("p_funding_avg_7d", n >= COVERAGE * 168 ? sum / n : null, "coverage");
    }

    const yearStart = close - 365 * D;
    if (yearStart < first(s)) set("p_funding_rank_1y", null, "warmup");
    else if (!now) set("p_funding_rank_1y", null, "stale");
    else {
      let below = 0;
      let equal = 0;
      let n = 0;
      for (let j = i - 1; j >= 0 && s.times[j]! >= yearStart; j--) {
        const v = s.pts[j]!.value;
        n++;
        if (v < now.value) below++;
        else if (v === now.value) equal++;
      }
      set("p_funding_rank_1y", n >= COVERAGE * 8_760 ? (below + 0.5 * equal) / n : null, "coverage");
    }
  }

  if (ext.oi) {
    const s = ext.oi;
    const i = lastAtOrBefore(s, close);
    const now = i >= 0 && close - s.times[i]! <= MAX_AGE ? s.pts[i]!.value : null;
    set("p_oi_usd", now, i < 0 ? "warmup" : "stale");
    for (const [name, back] of [["p_oi_chg_24h", D], ["p_oi_chg_7d", 7 * D]] as const) {
      const target = close - back;
      if (now === null) set(name, null, i < 0 ? "warmup" : "stale");
      else if (target < first(s)) set(name, null, "warmup");
      else {
        const j = lastAtOrBefore(s, target);
        const ok = j >= 0 && target - s.times[j]! <= MAX_AGE;
        set(name, ok ? now / s.pts[j]!.value - 1 : null, "gap");
      }
    }
  }

  if (ext.fng) {
    const s = ext.fng;
    const known = close - D;
    const i = lastAtOrBefore(s, known);
    const cur = i >= 0 && known - s.times[i]! <= FNG_MAX_AGE ? s.pts[i]! : null;
    set("s_fng", cur?.value ?? null, i < 0 ? "warmup" : "stale");
    if (!cur) set("s_fng_chg_7d", null, i < 0 ? "warmup" : "stale");
    else {
      const j = lastAtOrBefore(s, cur.time - 7 * D);
      const ok = j >= 0 && s.times[j] === cur.time - 7 * D;
      set("s_fng_chg_7d", ok ? cur.value - s.pts[j]!.value : null, cur.time - 7 * D < first(s) ? "warmup" : "gap");
    }
  }

  return { values, missing };
}
