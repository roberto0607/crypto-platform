/**
 * The recorder's candle series: Coinbase 1h and 1d (feature_candles), 4h
 * rolled up from 1h and 1w from 1d with the same rules as the shared
 * candles rollups (market/candleBackfill.ts): UTC-aligned 4h buckets that
 * need all four hours, Monday 00:00 UTC weeks that need all seven days.
 */
import type { Candle } from "../../indicators/shared";

const H1 = 3_600;
const H4 = 14_400;
const D1 = 86_400;
const W1 = 604_800;
/** 1970-01-05 00:00 UTC was a Monday. */
const MONDAY_EPOCH = 4 * D1;

function rollup(cs: Candle[], bucketOf: (t: number) => number, need: number, step: number): Candle[] {
  const out: Candle[] = [];
  let group: Candle[] = [];
  let bucket = Number.NaN;
  const flush = () => {
    if (group.length === need && group.every((c, i) => c.time === bucket + i * step)) {
      out.push({
        time: bucket,
        open: group[0]!.open,
        high: Math.max(...group.map((c) => c.high)),
        low: Math.min(...group.map((c) => c.low)),
        close: group[group.length - 1]!.close,
        volume: group.reduce((s, c) => s + c.volume, 0),
      });
    }
  };
  for (const c of cs) {
    const b = bucketOf(c.time);
    if (b !== bucket) {
      flush();
      group = [];
      bucket = b;
    }
    group.push(c);
  }
  flush();
  return out;
}

/** 4h bars from ascending 1h bars. */
export function rollup4h(h1: Candle[]): Candle[] {
  return rollup(h1, (t) => Math.floor(t / H4) * H4, 4, H1);
}

/** Monday-aligned weekly bars from ascending daily bars. */
export function rollupWeekly(d1: Candle[]): Candle[] {
  return rollup(d1, (t) => Math.floor((t - MONDAY_EPOCH) / W1) * W1 + MONDAY_EPOCH, 7, D1);
}

/** Bars whose close (open + tfSec) is at or before `t`. */
export function closedBy(cs: Candle[], tfSec: number, t: number): Candle[] {
  return cs.filter((c) => c.time + tfSec <= t);
}
