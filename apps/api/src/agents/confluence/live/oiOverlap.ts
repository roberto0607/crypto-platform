/**
 * OI overlap check (approved 2026-11-16; daily-point time set to 16:00 UTC
 * on 2026-11-22). The study's OI is the Binance archive; the live recorder's
 * is Gate.io + OKX. Over the 180 days both exist, compare them on one daily
 * point per day, at 16:00 UTC: OKX's daily points are stamped then (00:00
 * Hong Kong) and its hourly history only reaches back ~30 days, so 16:00 is
 * the only time all three sources have a real reading every day.
 *
 * Pearson correlation of the 24h % changes and of the 7d % changes (each
 * between two daily points exactly 1 / 7 days apart). PASS only if both are
 * ≥ 0.8; otherwise the OI features stay out of the live scorecard.
 */
import type { Point } from "../../../indicators/shared";
import { combineOi } from "../external/gateOkxOi";

const D = 86_400;
export const OI_OVERLAP = { hourUtc: 16, minCorrelation: 0.8, days: 180 } as const;

export function pearson(x: number[], y: number[]): number {
  const n = x.length;
  if (n < 2 || y.length !== n) return NaN;
  const mx = x.reduce((a, b) => a + b, 0) / n;
  const my = y.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (x[i]! - mx) * (y[i]! - my);
    sxx += (x[i]! - mx) ** 2;
    syy += (y[i]! - my) ** 2;
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : NaN;
}

/** Values stamped exactly at hourUtc:00:00 of a UTC day. */
const dailyAt = (pts: Point[]) => new Map(pts.filter((p) => ((p.time % D) + D) % D === OI_OVERLAP.hourUtc * 3_600).map((p) => [p.time, p.value]));

export interface OiOverlapResult {
  points: number;
  first: number | null;
  last: number | null;
  n24h: number;
  n7d: number;
  r24h: number;
  r7d: number;
  pass: boolean;
}

export function oiOverlapCheck(input: { binance: Point[]; gate: Point[]; okx: Point[] }): OiOverlapResult {
  const b = dailyAt(input.binance);
  const live = dailyAt(combineOi(input.gate, input.okx));
  const times = [...b.keys()].filter((t) => live.has(t)).sort((x, y) => x - y);
  const both = new Set(times);
  const changes = (back: number) => {
    const x: number[] = [];
    const y: number[] = [];
    for (const t of times) {
      if (!both.has(t - back)) continue;
      x.push(b.get(t)! / b.get(t - back)! - 1);
      y.push(live.get(t)! / live.get(t - back)! - 1);
    }
    return { n: x.length, r: pearson(x, y) };
  };
  const c24 = changes(D);
  const c7 = changes(7 * D);
  return {
    points: times.length,
    first: times[0] ?? null,
    last: times[times.length - 1] ?? null,
    n24h: c24.n,
    n7d: c7.n,
    r24h: c24.r,
    r7d: c7.r,
    pass: c24.r >= OI_OVERLAP.minCorrelation && c7.r >= OI_OVERLAP.minCorrelation,
  };
}
