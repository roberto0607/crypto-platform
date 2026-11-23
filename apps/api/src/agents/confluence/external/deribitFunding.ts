/**
 * Deribit BTC-PERPETUAL funding history (public, US-accessible, hourly back
 * to at least 2019-05). Point = (timestamp, interest_8h): the 8h-equivalent
 * funding rate as a fraction, known at that timestamp. One source for both
 * the backfill and the live recorder; the chart's funding stays on Gate.io.
 */
import type { Point } from "../../../indicators/shared";
import { defaultHttp, pause, type Http } from "./http";

const URL_BASE = "https://www.deribit.com/api/v2/public/get_funding_rate_history";
const WINDOW_MS = 30 * 86_400_000;

/** Hourly points in [from, toExclusive), 30-day requests. */
export async function fetchDeribitFunding(opts: { from: number; toExclusive: number; http?: Http; sleepMs?: number }): Promise<Point[]> {
  const http = opts.http ?? defaultHttp;
  const byTime = new Map<number, number>();
  const endMs = opts.toExclusive * 1000 - 1;
  for (let s = opts.from * 1000; s <= endMs; s += WINDOW_MS) {
    const e = Math.min(s + WINDOW_MS - 1, endMs);
    const json = (await http.json(`${URL_BASE}?instrument_name=BTC-PERPETUAL&start_timestamp=${s}&end_timestamp=${e}`)) as {
      result?: Array<{ timestamp: number; interest_8h: number }>;
    };
    for (const r of json.result ?? []) {
      const t = Math.floor(r.timestamp / 1000);
      if (t >= opts.from && t < opts.toExclusive && Number.isFinite(r.interest_8h)) byTime.set(t, r.interest_8h);
    }
    await pause(opts.sleepMs ?? 150);
  }
  return [...byTime.entries()].sort((a, b) => a[0] - b[0]).map(([time, value]) => ({ time, value }));
}
