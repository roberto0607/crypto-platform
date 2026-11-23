/**
 * Live feature recorder (Phase 1). At each 4h close + 5 minutes it writes
 * one setup_features row (origin "live") for the bar that just closed. No
 * orders, no LLM. Run by featureRecorderJob behind FEATURE_RECORDER_ENABLED.
 *
 * - Same code as the backfill: featureRowAtClose on Coinbase candles, then
 *   the external features as of the close. OI is Gate.io + OKX here (the
 *   backfill's Binance archive is geo-blocked from Railway).
 * - Idempotent: a bar that already has a row is skipped, never rewritten.
 * - Catch-up: bars of the last 7 days without a row are recorded too, and a
 *   row written more than 30 minutes after its close is marked
 *   recorded_late. Book imbalance and the news gate are snapshots of "now",
 *   so late rows leave them NULL ("late").
 * - A source that fails is logged; its columns that end up NULL get the
 *   reason "source_error", and the row is still written.
 * - Nothing is fetched or written while the DB-size guardrail pauses
 *   non-essential writes.
 */
import { pool } from "../../../db/pool";
import { config } from "../../../config";
import type { Point } from "../../../indicators/shared";
import { getCurrentOrderBookSignal } from "../../../market/orderBookAggregator";
import { nonEssentialWritesPaused } from "../../../observability/writePause";
import { featureRowAtClose, type FeatureRow } from "../computeFeatures";
import { rollup4h, rollupWeekly } from "../featureCandles";
import { latestFeatureCandleTime, loadFeatureCandles } from "../featureCandleRepo";
import { syncCoinbaseCandles, type FetchPage } from "../featureCandleSync";
import type { NumFeature } from "../featureColumns";
import { FEATURE_PERIODS, FEATURE_SYMBOL, FEATURE_VERSION } from "../featureParams";
import { upsertFeatureRows } from "../setupFeatureRepo";
import { withExternal } from "../featureBackfill";
import { EXTERNAL_LOOKBACK, SERIES } from "../external/externalBackfill";
import { prepareExternal } from "../external/externalFeatures";
import { latestExternalTime, loadExternalSeries, storeExternalSeries, type ExternalResolution } from "../external/externalSeriesRepo";
import { fetchDeribitFunding } from "../external/deribitFunding";
import { fetchFearGreedHistory } from "../external/fearGreedHistory";
import { combineOi, fetchGateOi, fetchOkxOi } from "../external/gateOkxOi";
import type { Http } from "../external/http";
import {
  bookImbalanceFrom,
  footprintBarFlow,
  readNewsGate,
  realCvdAt,
  FLOW_SERIES,
  type BarFlow,
  type BookSnapshot,
  type LiveValue,
} from "./liveSignals";

const H = 3_600;
const H4 = 14_400;
const D = 86_400;

export const RECORDER = {
  /** Record at close + 5 minutes. */
  delaySec: 300,
  /** Written more than 30 minutes after its close = recorded_late. */
  lateSec: 1_800,
  /** How far back missing bars are caught up: 7 days of 4h bars. */
  catchUpBars: 42,
} as const;

/** Columns each source fills, for "source_error". */
const SOURCE_COLUMNS: Record<string, NumFeature[]> = {
  funding: ["p_funding_8h", "p_funding_avg_7d", "p_funding_rank_1y"],
  gate: ["p_oi_usd", "p_oi_chg_24h", "p_oi_chg_7d"],
  okx: ["p_oi_usd", "p_oi_chg_24h", "p_oi_chg_7d"],
  fng: ["s_fng", "s_fng_chg_7d"],
  footprint: ["f_cvd_real_24h", "f_cvd_real_7d"],
};

export interface RecorderOptions {
  nowSec?: number;
  symbol?: string;
  /** Test isolation: prefix for external_series names. */
  seriesPrefix?: string;
  /** First candle to sync into an empty feature_candles (default 2015-07-20, as the backfill). */
  historyStart?: number;
  resolution?: ExternalResolution;
  http?: Http;
  fetchPage?: FetchPage;
  sleepMs?: number;
  paused?: () => boolean;
  bookSnapshot?: () => BookSnapshot | null;
  newsGate?: (atSec: number) => Promise<LiveValue<boolean>>;
  footprintFlow?: (barTime: number) => Promise<BarFlow | null>;
  log?: (msg: string) => void;
}

export interface RecorderSummary {
  status: "paused" | "idle" | "recorded";
  rows: Array<{ barTime: number; late: boolean }>;
  sourceErrors: string[];
}

const utcDay = (d: string) => Date.parse(`${d}T00:00:00Z`) / 1000;

export async function runFeatureRecorder(o: RecorderOptions = {}): Promise<RecorderSummary> {
  const paused = o.paused ?? nonEssentialWritesPaused;
  if (paused()) return { status: "paused", rows: [], sourceErrors: [] };

  const now = o.nowSec ?? Math.floor(Date.now() / 1000);
  const symbol = o.symbol ?? FEATURE_SYMBOL;
  const prefix = o.seriesPrefix ?? "";
  const resolution = o.resolution ?? config.externalSeriesResolution;
  const log = o.log ?? (() => {});
  const { http, fetchPage, sleepMs } = o;

  // ── Which closes still need a row ──
  const lastClose = Math.floor((now - RECORDER.delaySec) / H4) * H4;
  const firstClose = lastClose - (RECORDER.catchUpBars - 1) * H4;
  const { rows: have } = await pool.query<{ t: string }>(
    `SELECT extract(epoch FROM bar_time)::bigint::text AS t FROM setup_features
      WHERE symbol = $1 AND feature_version = $2 AND bar_time >= to_timestamp($3::double precision)`,
    [symbol, FEATURE_VERSION, firstClose - H4],
  );
  const recorded = new Set(have.map((r) => Number(r.t) + H4));
  const pending: number[] = [];
  for (let c = firstClose; c <= lastClose; c += H4) if (!recorded.has(c)) pending.push(c);
  if (pending.length === 0) return { status: "idle", rows: [], sourceErrors: [] };

  const errors = new Set<string>();
  const attempt = async (source: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (err) {
      errors.add(source);
      log(`[recorder] ${source} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const minClose = pending[0]!;

  // ── Top up candles (Coinbase revises recent bars: re-fetch the last two) ──
  const historyStart = o.historyStart ?? utcDay(FEATURE_PERIODS.candleHistoryStart);
  for (const [tf, sec] of [["1h", H], ["1d", D]] as const) {
    await attempt("coinbase", async () => {
      const latest = await latestFeatureCandleTime(symbol, tf);
      const from = latest === null ? historyStart : latest - sec;
      await syncCoinbaseCandles({ symbol, timeframe: tf, from, to: lastClose, nowSec: now, fetchPage, sleepMs });
    });
  }

  // ── Top up external series ──
  const s = (k: keyof typeof SERIES) => prefix + SERIES[k];
  const after = async (series: string, floor: number) => {
    const t = await latestExternalTime(series);
    return Math.max(floor, t === null ? floor : t + 1);
  };
  const to = lastClose + 1;
  const fundingFrom = minClose - EXTERNAL_LOOKBACK.funding;
  const oiFrom = minClose - EXTERNAL_LOOKBACK.oi - H;
  const fngFrom = minClose - EXTERNAL_LOOKBACK.fng;
  await attempt("funding", async () => {
    const pts = await fetchDeribitFunding({ from: await after(s("funding"), fundingFrom), toExclusive: to, http, sleepMs });
    await storeExternalSeries(s("funding"), pts, resolution);
  });
  await attempt("gate", async () => {
    const pts = await fetchGateOi({ from: await after(s("gateOi"), oiFrom), toExclusive: to, http, sleepMs });
    await storeExternalSeries(s("gateOi"), pts, resolution);
  });
  await attempt("okx", async () => {
    await storeExternalSeries(s("okxOi"), await fetchOkxOi({ period: "1H", from: oiFrom, toExclusive: to, http }), resolution);
  });
  await attempt("fng", async () => {
    const pts = (await fetchFearGreedHistory({ http })).filter((p) => p.time >= fngFrom && p.time < to);
    await storeExternalSeries(s("fng"), pts, resolution);
  });

  // ── Kraken flow per 4h bar, while footprint_candles still has it (24 h) ──
  const flowFn = o.footprintFlow ?? ((t: number) => footprintBarFlow(t));
  await attempt("footprint", async () => {
    const stored = new Set((await loadExternalSeries(prefix + FLOW_SERIES.delta, lastClose - D, lastClose)).map((p) => p.time));
    for (let bar = lastClose - D; bar + H4 <= lastClose; bar += H4) {
      if (stored.has(bar)) continue;
      const f = await flowFn(bar);
      if (!f) continue;
      await storeExternalSeries(prefix + FLOW_SERIES.delta, [{ time: bar, value: f.delta }], "full");
      await storeExternalSeries(prefix + FLOW_SERIES.volume, [{ time: bar, value: f.volume }], "full");
    }
  });

  // ── Compute ──
  const h1 = await loadFeatureCandles(symbol, "1h", lastClose);
  const d1 = await loadFeatureCandles(symbol, "1d", lastClose);
  const candles = { h4: rollup4h(h1), d1, w1: rollupWeekly(d1) };
  const load = (series: string, from: number) => loadExternalSeries(series, from, to);
  const ext = prepareExternal({
    funding: await load(s("funding"), fundingFrom),
    oi: combineOi(await load(s("gateOi"), oiFrom), await load(s("okxOi"), oiFrom)),
    fng: await load(s("fng"), fngFrom),
  });
  const flowFrom = minClose - 8 * D;
  const flowDelta: Point[] = await load(prefix + FLOW_SERIES.delta, flowFrom);
  const flowVolume: Point[] = await load(prefix + FLOW_SERIES.volume, flowFrom);
  const book = bookImbalanceFrom((o.bookSnapshot ?? getCurrentOrderBookSignal)(), now * 1000);
  const newsFn = o.newsGate ?? ((at: number) => readNewsGate({ enabled: config.newsAgentEnabled, symbol: "BTC/USD", atSec: at }));

  const written: RecorderSummary["rows"] = [];
  for (const close of pending) {
    const base = featureRowAtClose(candles, close);
    if (!base) {
      log(`[recorder] no 4h bar closes at ${new Date(close * 1000).toISOString()} yet (Coinbase gap?)`);
      continue;
    }
    const late = now - close > RECORDER.lateSec;
    let row: FeatureRow = withExternal(base, ext);
    const cvd = realCvdAt(close, flowDelta, flowVolume);
    const values = { ...row.values, ...cvd.values } as Record<string, number | boolean | null>;
    const missing = { ...row.missing, ...cvd.missing };
    if (late) {
      values.f_book_imbalance = null;
      missing.f_book_imbalance = "late";
      values.e_news_gate = null;
      missing.e_news_gate = "late";
    } else {
      values.f_book_imbalance = book.value;
      if (book.value === null) missing.f_book_imbalance = book.reason;
      let news: LiveValue<boolean>;
      try {
        news = await newsFn(now);
      } catch {
        errors.add("news");
        news = { value: null, reason: "source_error" };
      }
      values.e_news_gate = news.value;
      if (news.value === null) missing.e_news_gate = news.reason;
    }
    for (const src of errors) {
      for (const c of SOURCE_COLUMNS[src] ?? []) if (values[c] === null || values[c] === undefined) {
        values[c] = null;
        missing[c] = "source_error";
      }
    }
    row = { ...row, values: values as FeatureRow["values"], missing };
    await upsertFeatureRows(symbol, "live", [row], { recordedLate: late, ifAbsent: true });
    written.push({ barTime: base.barTime, late });
  }
  return { status: "recorded", rows: written, sourceErrors: [...errors] };
}
