/**
 * external_series: raw points from the external sources.
 *
 * Resolution (EXTERNAL_SERIES_RESOLUTION): "1h" (the default, and prod)
 * keeps the LAST point of each UTC hour, stamped at that point's own time;
 * "full" keeps every point and is for local research DBs only. Features
 * always read the hourly view (externalFeatures.prepareExternal), so they
 * are the same whichever resolution was stored.
 */
import { pool } from "../../../db/pool";
import type { Point } from "../../../indicators/shared";

export type ExternalResolution = "1h" | "full";
const BATCH = 5_000;

/** Last point per UTC hour, at its own timestamp. Input in any order. */
export function downsampleHourly(points: Point[]): Point[] {
  const byHour = new Map<number, Point>();
  for (const p of points) {
    const h = Math.floor(p.time / 3_600);
    const cur = byHour.get(h);
    if (!cur || p.time >= cur.time) byHour.set(h, p);
  }
  return [...byHour.values()].sort((a, b) => a.time - b.time);
}

/** Upsert points (replacing in place). Returns rows written. */
export async function storeExternalSeries(series: string, points: Point[], resolution: ExternalResolution): Promise<number> {
  const pts = resolution === "1h" ? downsampleHourly(points) : points;
  let written = 0;
  for (let i = 0; i < pts.length; i += BATCH) {
    const b = pts.slice(i, i + BATCH);
    const { rowCount } = await pool.query(
      `INSERT INTO external_series (series, ts, value)
       SELECT $1, to_timestamp(t), v FROM unnest($2::bigint[], $3::float8[]) AS u(t, v)
       ON CONFLICT (series, ts) DO UPDATE SET value = EXCLUDED.value`,
      [series, b.map((p) => p.time), b.map((p) => p.value)],
    );
    written += rowCount ?? 0;
  }
  return written;
}

/** Points with from <= ts < toExclusive, ascending. */
export async function loadExternalSeries(series: string, from: number, toExclusive: number): Promise<Point[]> {
  const { rows } = await pool.query<{ t: string; value: number }>(
    `SELECT extract(epoch FROM ts)::bigint::text AS t, value
       FROM external_series
      WHERE series = $1 AND ts >= to_timestamp($2::double precision) AND ts < to_timestamp($3::double precision)
      ORDER BY ts`,
    [series, from, toExclusive],
  );
  return rows.map((r) => ({ time: Number(r.t), value: r.value }));
}
