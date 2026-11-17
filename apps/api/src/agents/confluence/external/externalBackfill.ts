/**
 * Fill external_series for [from, toExclusive), plus the look-back the
 * features need: funding from a year + 8 days earlier (1-year rank + 7-day
 * mean), OI from 8 days earlier (7-day change), F&G from 30 days earlier.
 * Nothing at or after toExclusive is stored. (Alternative.me only serves
 * all-or-last-N, so F&G is fetched whole and clipped in memory.)
 *
 * Gate.io / OKX keep only 180 days, so they are fetched only when the range
 * reaches into the last 180 days: never for the in-sample period.
 * Components are stored separately (raw); combineOi sums them on read.
 */
import { config } from "../../../config";
import type { Point } from "../../../indicators/shared";
import { fetchBinanceOiDays } from "./binanceOi";
import { fetchDeribitFunding } from "./deribitFunding";
import { storeExternalSeries, type ExternalResolution } from "./externalSeriesRepo";
import { fetchFearGreedHistory } from "./fearGreedHistory";
import { fetchGateOi, fetchOkxOi } from "./gateOkxOi";
import type { Http } from "./http";

export const SERIES = {
  funding: "deribit_funding_btc",
  binanceOi: "binance_oi_btc_usd",
  gateOi: "gate_oi_btc_usd",
  okxOi: "okx_oi_btc_usd",
  fng: "fng",
} as const;

const D = 86_400;
/** How far before a row each series must start for its features to be defined. */
export const EXTERNAL_LOOKBACK = { funding: 373 * D, oi: 8 * D, fng: 30 * D } as const;
const LIVE_VENUE_HISTORY = 180 * D;

const day = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
const clip = (pts: Point[], from: number, to: number) => pts.filter((p) => p.time >= from && p.time < to);

export async function runExternalBackfill(opts: {
  from: number;
  toExclusive: number;
  http?: Http;
  seriesPrefix?: string;
  resolution?: ExternalResolution;
  sleepMs?: number;
  nowSec?: number;
  log?: (msg: string) => void;
}): Promise<{ counts: Record<string, number>; binanceMissingDays: string[] }> {
  const prefix = opts.seriesPrefix ?? "";
  const resolution = opts.resolution ?? config.externalSeriesResolution;
  const log = opts.log ?? (() => {});
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const { from, toExclusive: to, http, sleepMs } = opts;
  const counts: Record<string, number> = {};
  const store = async (key: keyof typeof SERIES, pts: Point[]) => {
    counts[SERIES[key]] = await storeExternalSeries(prefix + SERIES[key], clip(pts, -Infinity, to), resolution);
    log(`[external] ${SERIES[key]}: ${counts[SERIES[key]]} points stored (${resolution})`);
  };

  await store("funding", await fetchDeribitFunding({ from: from - EXTERNAL_LOOKBACK.funding, toExclusive: to, http, sleepMs }));

  const oiDayTo = day(to + D - 1); // days touching [.., to)
  const binance = await fetchBinanceOiDays({
    fromDay: day(from - EXTERNAL_LOOKBACK.oi), toDayExclusive: oiDayTo, http, sleepMs,
  });
  await store("binanceOi", clip(binance.points, from - EXTERNAL_LOOKBACK.oi, to));
  if (binance.missingDays.length > 0) log(`[external] Binance archive missing ${binance.missingDays.length} day(s): ${binance.missingDays.join(", ")}`);

  await store("fng", clip(await fetchFearGreedHistory({ http }), from - EXTERNAL_LOOKBACK.fng, to));

  const liveFrom = Math.max(from - EXTERNAL_LOOKBACK.oi, now - LIVE_VENUE_HISTORY);
  if (to > liveFrom) {
    await store("gateOi", await fetchGateOi({ from: liveFrom, toExclusive: to, http, sleepMs }));
    const okx = [
      ...(await fetchOkxOi({ period: "1D", from: liveFrom, toExclusive: to, http })),
      ...(await fetchOkxOi({ period: "1H", from: liveFrom, toExclusive: to, http })),
    ];
    await store("okxOi", [...new Map(okx.map((p) => [p.time, p])).values()].sort((a, b) => a.time - b.time));
  }

  return { counts, binanceMissingDays: binance.missingDays };
}
