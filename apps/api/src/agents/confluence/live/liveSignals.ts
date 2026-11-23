/**
 * Live-only feature inputs. None of these has history, so backfilled rows
 * leave them NULL ("live_only") and the Phase 2 study excludes them.
 *
 * - f_book_imbalance  (bid − ask) ÷ (bid + ask) of the Kraken dollar depth
 *                     within ±1% of mid, from orderBookAggregator's latest
 *                     reading (polled every 10 s), at most 60 s old. Read at
 *                     the run (close + ~5 min), not at the close instant.
 * - f_cvd_real_24h/7d net Kraken delta ÷ Kraken volume over the 6 / 42 4h
 *                     bars closed by the close, ≥ 90% of them present (the
 *                     same windows as the proxy). footprint_candles is
 *                     deleted after 24 h, so the recorder keeps each closed
 *                     4h bar's delta and volume in external_series
 *                     (FLOW_SERIES), stamped at the bar's open, and a bar
 *                     counts only if all 16 of its 15m candles exist.
 * - e_news_gate       BTC/USD has an unexpired negative pair_news_flags row.
 *                     NULL when the News Agent is off (nothing keeps the
 *                     flags fresh, so "false" would be a guess).
 */
import { pool } from "../../../db/pool";
import type { Point } from "../../../indicators/shared";
import type { FeatureValues } from "../featureColumns";
import { FEATURE_PARAMS as P } from "../featureParams";

const H4 = 14_400;
const COVERAGE = 0.9;
export const BOOK_MAX_AGE_MS = 60_000;
export const FLOW_SERIES = { delta: "kraken_delta_btc_4h", volume: "kraken_volume_btc_4h" } as const;

export interface LiveValue<T> {
  value: T | null;
  /** "" when there is a value. */
  reason: string;
}

export interface BookSnapshot {
  timestamp: number;
  kraken: { totalBidDollars: number; totalAskDollars: number };
}

export function bookImbalanceFrom(snap: BookSnapshot | null, nowMs: number): LiveValue<number> {
  if (!snap) return { value: null, reason: "unavailable" };
  if (nowMs - snap.timestamp > BOOK_MAX_AGE_MS) return { value: null, reason: "stale" };
  const { totalBidDollars: b, totalAskDollars: a } = snap.kraken;
  if (!(b + a > 0)) return { value: null, reason: "empty" };
  return { value: (b - a) / (b + a), reason: "" };
}

export interface BarFlow {
  delta: number;
  volume: number;
}

/** The 4h bar opening at `barTime`, summed from its 15m footprint candles; null unless all 16 exist. */
export async function footprintBarFlow(barTime: number, pair = "BTC"): Promise<BarFlow | null> {
  const { rows } = await pool.query<{ n: number; delta: string | null; volume: string | null }>(
    `SELECT count(*)::int AS n, sum(delta)::text AS delta, sum(total_buy_qty + total_sell_qty)::text AS volume
       FROM footprint_candles
      WHERE pair = $1 AND timeframe = '15m'
        AND open_time >= to_timestamp($2::double precision) AND open_time < to_timestamp($2::double precision + $3)`,
    [pair, barTime, H4],
  );
  const r = rows[0];
  if (!r || r.n < H4 / 900) return null;
  return { delta: Number(r.delta), volume: Number(r.volume) };
}

/** Real CVD at a 4h close from the stored per-bar flow (points at bar open times). */
export function realCvdAt(close: number, delta: Point[], volume: Point[]): { values: FeatureValues; missing: Record<string, string> } {
  const values: FeatureValues = {};
  const missing: Record<string, string> = {};
  const vol = new Map(volume.map((p) => [p.time, p.value]));
  const first = delta.length > 0 ? Math.min(...delta.map((p) => p.time)) : Infinity;
  for (const [name, sec] of [["f_cvd_real_24h", P.cvdShortSec], ["f_cvd_real_7d", P.cvdLongSec]] as const) {
    const start = close - sec;
    let d = 0;
    let v = 0;
    let n = 0;
    for (const p of delta) {
      if (p.time < start || p.time + H4 > close || !vol.has(p.time)) continue;
      d += p.value;
      v += vol.get(p.time)!;
      n++;
    }
    let reason = "";
    if (start < first) reason = "warmup";
    else if (n < COVERAGE * (sec / H4)) reason = "coverage";
    else if (!(v > 0)) reason = "no_volume";
    values[name] = reason ? null : d / v;
    if (reason) missing[name] = reason;
  }
  return { values, missing };
}

export async function readNewsGate(opts: { enabled: boolean; symbol: string; atSec: number }): Promise<LiveValue<boolean>> {
  if (!opts.enabled) return { value: null, reason: "news_agent_off" };
  const { rows } = await pool.query<{ flagged: boolean | null }>(
    `SELECT (SELECT f.flagged_negative AND f.expires_at > to_timestamp($2::double precision)
               FROM pair_news_flags f WHERE f.pair_id = p.id) AS flagged
       FROM trading_pairs p WHERE p.symbol = $1`,
    [opts.symbol, opts.atSec],
  );
  if (rows.length === 0) return { value: null, reason: "no_pair" };
  return { value: rows[0]!.flagged === true, reason: "" };
}
