/**
 * The factor study's data: backfilled setup_features rows and the Coinbase
 * 4h bars they were computed from, for an in-sample window only. Nothing
 * from 2024-01-01 on is read: the window is refused if it reaches past it,
 * rows must close by the window's end, and candles must close by it too.
 */
import { pool } from "../../../db/pool";
import type { Candle } from "../../../indicators/shared";
import { loadFeatureCandles } from "../featureCandleRepo";
import { rollup4h } from "../featureCandles";
import { FEATURE_SYMBOL, FEATURE_VERSION } from "../featureParams";
import { STUDY_FEATURES, STUDY_PREREGISTRATION as S } from "./studyParams";

const H4 = 14_400;
const utc = (d: string): number => {
  const t = Date.parse(`${d}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(t)) throw new Error(`bad date "${d}" (want YYYY-MM-DD)`);
  return t / 1000;
};

/** [from, toExclusive) in seconds, inside the in-sample window. */
export function studyWindow(opts: { from?: string; toExclusive?: string } = {}): { from: number; toExclusive: number } {
  const from = utc(opts.from ?? S.inSample.start);
  const toExclusive = utc(opts.toExclusive ?? S.inSample.endExclusive);
  if (toExclusive > utc(S.inSample.endExclusive)) throw new Error(`${S.inSample.endExclusive} on is out of sample: the study never reads it`);
  if (from < utc(S.inSample.start) || toExclusive <= from) throw new Error("window must be a non-empty part of the in-sample period");
  return { from, toExclusive };
}

export interface StudyRow {
  barTime: number;
  /** Index of this bar in StudyData.h4. */
  k: number;
  year: number;
  atr: number | null;
  values: Record<string, number | null>;
}

export interface StudyData {
  window: { from: number; toExclusive: number };
  h4: Candle[];
  rows: StudyRow[];
}

export async function loadStudyData(window: { from: number; toExclusive: number }, symbol = FEATURE_SYMBOL): Promise<StudyData> {
  if (window.toExclusive > utc(S.inSample.endExclusive)) throw new Error("out of sample");
  const h4 = rollup4h(await loadFeatureCandles(symbol, "1h", window.toExclusive)).filter((c) => c.time + H4 <= window.toExclusive);
  const index = new Map(h4.map((c, i) => [c.time, i]));
  const cols = STUDY_FEATURES.map((f) => f.name);
  const { rows } = await pool.query(
    `SELECT extract(epoch FROM bar_time)::bigint::text AS t, atr14_4h, ${cols.join(", ")}
       FROM setup_features
      WHERE symbol = $1 AND feature_version = $2 AND origin = 'backfill'
        AND bar_time >= to_timestamp($3::double precision)
        AND bar_time + interval '4 hours' <= to_timestamp($4::double precision)
      ORDER BY bar_time`,
    [symbol, FEATURE_VERSION, window.from, window.toExclusive],
  );
  const out: StudyRow[] = [];
  for (const r of rows) {
    const barTime = Number(r.t);
    const k = index.get(barTime);
    if (k === undefined) continue; // no 4h candle for it (a gap in the 1h data)
    const values: Record<string, number | null> = {};
    for (const c of cols) values[c] = r[c] === null ? null : Number(r[c]);
    out.push({ barTime, k, year: new Date(barTime * 1000).getUTCFullYear(), atr: r.atr14_4h === null ? null : Number(r.atr14_4h), values });
  }
  return { window, h4, rows: out };
}
