/** feature_candles: the recorder's own Coinbase 1h/1d history. */
import { pool } from "../../db/pool";
import type { Candle } from "../../indicators/shared";

export type FeatureTimeframe = "1h" | "1d";
const TF_SEC: Record<FeatureTimeframe, number> = { "1h": 3_600, "1d": 86_400 };
const BATCH = 1_000;

/** Insert or replace bars (Coinbase revises recent bars). Returns rows written. */
export async function upsertFeatureCandles(symbol: string, timeframe: FeatureTimeframe, candles: Candle[]): Promise<number> {
  let written = 0;
  for (let i = 0; i < candles.length; i += BATCH) {
    const b = candles.slice(i, i + BATCH);
    const { rowCount } = await pool.query(
      `INSERT INTO feature_candles (symbol, timeframe, ts, open, high, low, close, volume)
       SELECT $1, $2, to_timestamp(t), o, h, l, c, v
         FROM unnest($3::bigint[], $4::float8[], $5::float8[], $6::float8[], $7::float8[], $8::float8[]) AS u(t, o, h, l, c, v)
       ON CONFLICT (symbol, timeframe, ts) DO UPDATE SET
         open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low,
         close = EXCLUDED.close, volume = EXCLUDED.volume`,
      [symbol, timeframe, b.map((c) => c.time), b.map((c) => c.open), b.map((c) => c.high), b.map((c) => c.low), b.map((c) => c.close), b.map((c) => c.volume)],
    );
    written += rowCount ?? 0;
  }
  return written;
}

/** Bars whose close is at or before `endSec`, ascending. */
export async function loadFeatureCandles(symbol: string, timeframe: FeatureTimeframe, endSec: number): Promise<Candle[]> {
  const { rows } = await pool.query<{ t: string; open: number; high: number; low: number; close: number; volume: number }>(
    `SELECT extract(epoch FROM ts)::bigint::text AS t, open, high, low, close, volume
       FROM feature_candles
      WHERE symbol = $1 AND timeframe = $2 AND ts <= to_timestamp($3::double precision - $4)
      ORDER BY ts`,
    [symbol, timeframe, endSec, TF_SEC[timeframe]],
  );
  return rows.map((r) => ({ time: Number(r.t), open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume }));
}

/** Open time of the latest stored bar, or null. */
export async function latestFeatureCandleTime(symbol: string, timeframe: FeatureTimeframe): Promise<number | null> {
  const { rows } = await pool.query<{ t: string | null }>(
    `SELECT extract(epoch FROM max(ts))::bigint::text AS t FROM feature_candles WHERE symbol = $1 AND timeframe = $2`,
    [symbol, timeframe],
  );
  return rows[0]?.t ? Number(rows[0].t) : null;
}
