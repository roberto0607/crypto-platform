/**
 * Backfill: Coinbase 1h/1d candles into feature_candles, then one
 * setup_features row per closed 4h bar in [from, toExclusive).
 *
 * In-sample by default (2019-05-19 → 2024-01-01). Nothing at or after
 * 2024-01-01 is fetched, stored or computed unless --confirm-oos is passed:
 * the out-of-sample period stays unread until the in-sample study is done.
 */
import type { Candle } from "../../indicators/shared";
import { buildFeatureSeries, featureRowAt, type FeatureRow } from "./computeFeatures";
import { rollup4h, rollupWeekly } from "./featureCandles";
import { loadFeatureCandles } from "./featureCandleRepo";
import { syncCoinbaseCandles, type FetchPage } from "./featureCandleSync";
import { FEATURE_PERIODS, FEATURE_SYMBOL } from "./featureParams";
import { upsertFeatureRows } from "./setupFeatureRepo";
import { EXTERNAL_LOOKBACK, SERIES } from "./external/externalBackfill";
import { externalFeaturesAt, prepareExternal, type ExternalInput, type PreparedExternal } from "./external/externalFeatures";
import { loadExternalSeries } from "./external/externalSeriesRepo";

const H4 = 14_400;

const utc = (d: string): number => {
  const t = Date.parse(`${d}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(t)) throw new Error(`bad date "${d}" (want YYYY-MM-DD)`);
  return t / 1000;
};

/** --from / --to (YYYY-MM-DD, UTC; --to exclusive). Refuses the out-of-sample period without --confirm-oos. */
export function backfillRange(argv: string[]): { from: number; toExclusive: number } {
  const arg = (n: string) => {
    const i = argv.indexOf(`--${n}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const from = utc(arg("from") ?? FEATURE_PERIODS.inSampleStart);
  const toExclusive = utc(arg("to") ?? FEATURE_PERIODS.inSampleEndExclusive);
  if (toExclusive <= from) throw new Error("--from must be before --to");
  if (toExclusive > utc(FEATURE_PERIODS.inSampleEndExclusive) && !argv.includes("--confirm-oos")) {
    throw new Error(`rows from ${FEATURE_PERIODS.inSampleEndExclusive} on are out of sample: pass --confirm-oos to write them`);
  }
  return { from, toExclusive };
}

export interface BackfillSummary {
  candles: { h1: number; d1: number };
  rows: number;
  first: number | null;
  last: number | null;
  nullCounts: Record<string, number>;
}

/** Merge the external (positioning / sentiment) features into a row, as of its close. */
export function withExternal(row: FeatureRow, ext: PreparedExternal): FeatureRow {
  const e = externalFeaturesAt(row.closeTime, ext);
  return { ...row, values: { ...row.values, ...e.values }, missing: { ...row.missing, ...e.missing } };
}

/**
 * Backfill rows use the Binance archive for OI (the live recorder uses
 * Gate.io + OKX). A series with no stored points is left unloaded, so its
 * columns read "source_not_wired" rather than a misleading warm-up.
 */
export async function loadBackfillExternal(from: number, toExclusive: number, prefix = ""): Promise<PreparedExternal> {
  const load = async (series: string, back: number) => {
    const pts = await loadExternalSeries(prefix + series, from - back, toExclusive);
    return pts.length > 0 ? pts : undefined;
  };
  const input: ExternalInput = {
    funding: await load(SERIES.funding, EXTERNAL_LOOKBACK.funding),
    oi: await load(SERIES.binanceOi, EXTERNAL_LOOKBACK.oi),
    fng: await load(SERIES.fng, EXTERNAL_LOOKBACK.fng),
  };
  return prepareExternal(input);
}

/** Rows for every 4h bar in [from, toExclusive) whose close is ≤ toExclusive, computed over the full stored history. */
export function computeBackfillRows(h1: Candle[], d1: Candle[], from: number, toExclusive: number, ext: PreparedExternal = {}): FeatureRow[] {
  const h4 = rollup4h(h1);
  const series = buildFeatureSeries({ h4, d1, w1: rollupWeekly(d1) });
  const rows: FeatureRow[] = [];
  for (let k = 0; k < h4.length; k++) {
    const t = h4[k]!.time;
    if (t >= from && t + H4 <= toExclusive) rows.push(withExternal(featureRowAt(series, k), ext));
  }
  return rows;
}

export async function runFeatureBackfill(opts: {
  from: number;
  toExclusive: number;
  symbol?: string;
  fetchPage?: FetchPage;
  sleepMs?: number;
  skipSync?: boolean;
  /** Test isolation: prefix for external_series names. */
  seriesPrefix?: string;
  log?: (msg: string) => void;
}): Promise<BackfillSummary> {
  const symbol = opts.symbol ?? FEATURE_SYMBOL;
  const log = opts.log ?? (() => {});
  const historyStart = utc(FEATURE_PERIODS.candleHistoryStart);
  const synced = { h1: 0, d1: 0 };
  if (!opts.skipSync) {
    for (const tf of ["1h", "1d"] as const) {
      synced[tf === "1h" ? "h1" : "d1"] = await syncCoinbaseCandles({
        symbol, timeframe: tf, from: historyStart, to: opts.toExclusive, fetchPage: opts.fetchPage, sleepMs: opts.sleepMs,
      });
      log(`[features] synced ${tf}: ${synced[tf === "1h" ? "h1" : "d1"]} bars`);
    }
  }
  const h1 = await loadFeatureCandles(symbol, "1h", opts.toExclusive);
  const d1 = await loadFeatureCandles(symbol, "1d", opts.toExclusive);
  log(`[features] loaded ${h1.length} 1h and ${d1.length} 1d bars closed by ${new Date(opts.toExclusive * 1000).toISOString()}`);
  const ext = await loadBackfillExternal(opts.from, opts.toExclusive, opts.seriesPrefix);
  log(`[features] external series loaded: ${Object.entries(ext).filter(([, v]) => v).map(([k, v]) => `${k} ${v!.pts.length}`).join(", ") || "none"}`);
  const rows = computeBackfillRows(h1, d1, opts.from, opts.toExclusive, ext);
  const written = await upsertFeatureRows(symbol, "backfill", rows);
  const nullCounts: Record<string, number> = {};
  for (const r of rows) for (const [k] of Object.entries(r.missing)) nullCounts[k] = (nullCounts[k] ?? 0) + 1;
  return {
    candles: synced,
    rows: written,
    first: rows[0]?.barTime ?? null,
    last: rows[rows.length - 1]?.barTime ?? null,
    nullCounts,
  };
}
