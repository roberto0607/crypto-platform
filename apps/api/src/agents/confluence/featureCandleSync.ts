/**
 * Coinbase → feature_candles: page the public candles endpoint forward and
 * store only bars that had closed. Used by the backfill and (PR 1b) the live
 * recorder's top-up, so both read the same exchange.
 */
import type { Candle } from "../../indicators/shared";
import { fetchCoinbaseCandles, sleep, type CoinbaseGranularity, type OHLCEntry } from "../../marketData/coinbaseRest";
import { upsertFeatureCandles, type FeatureTimeframe } from "./featureCandleRepo";

const PAGE_BARS = 300;
const TF: Record<FeatureTimeframe, { sec: number; granularity: CoinbaseGranularity }> = {
  "1h": { sec: 3_600, granularity: "ONE_HOUR" },
  "1d": { sec: 86_400, granularity: "ONE_DAY" },
};

export type FetchPage = (productId: string, granularity: CoinbaseGranularity, start: number, end: number) => Promise<OHLCEntry[]>;

/**
 * Page Coinbase forward over [from, to), ≤ 300 bars a request, and store the
 * bars that had closed by `nowSec`. Returns bars stored.
 */
export async function syncCoinbaseCandles(opts: {
  symbol: string;
  timeframe: FeatureTimeframe;
  from: number;
  to: number;
  nowSec?: number;
  fetchPage?: FetchPage;
  sleepMs?: number;
  store?: (cs: Candle[]) => Promise<number>;
}): Promise<number> {
  const { sec, granularity } = TF[opts.timeframe];
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const fetchPage = opts.fetchPage ?? fetchCoinbaseCandles;
  const store = opts.store ?? ((cs: Candle[]) => upsertFeatureCandles(opts.symbol, opts.timeframe, cs));
  const limit = Math.min(opts.to, now - sec + 1); // last open time allowed (exclusive) = closed by now
  let cursor = Math.floor(opts.from / sec) * sec;
  let stored = 0;
  while (cursor < limit) {
    const end = cursor + (PAGE_BARS - 1) * sec;
    const page = await fetchPage(opts.symbol, granularity, cursor, end);
    const keep = page
      .filter((e) => e.time >= opts.from && e.time < opts.to && e.time + sec <= now && e.time >= cursor && e.time <= end)
      .map((e): Candle => ({ time: e.time, open: Number(e.open), high: Number(e.high), low: Number(e.low), close: Number(e.close), volume: Number(e.volume) }));
    if (keep.length > 0) stored += await store(keep);
    cursor = end + sec;
    if (opts.sleepMs ?? 150) await sleep(opts.sleepMs ?? 150);
  }
  return stored;
}
