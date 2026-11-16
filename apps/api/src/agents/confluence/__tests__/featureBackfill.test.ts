import { describe, it, expect } from "vitest";
import { backfillRange } from "../featureBackfill";
import type { OHLCEntry } from "../../../marketData/coinbaseRest";

const utc = (d: string) => Date.parse(`${d}T00:00:00Z`) / 1000;

describe("backfillRange", () => {
  it("defaults to the in-sample period and never reaches 2024-01-01", () => {
    expect(backfillRange([])).toEqual({ from: utc("2019-05-19"), toExclusive: utc("2024-01-01") });
    expect(backfillRange(["--from", "2020-01-01", "--to", "2021-01-01"])).toEqual({ from: utc("2020-01-01"), toExclusive: utc("2021-01-01") });
  });

  it("refuses to write rows from 2024-01-01 on without --confirm-oos", () => {
    expect(() => backfillRange(["--to", "2024-06-01"])).toThrow(/--confirm-oos/);
    expect(backfillRange(["--to", "2024-06-01", "--confirm-oos"])).toEqual({ from: utc("2019-05-19"), toExclusive: utc("2024-06-01") });
  });

  it("rejects a bad range", () => {
    expect(() => backfillRange(["--from", "2021-01-01", "--to", "2020-01-01"])).toThrow(/before/);
    expect(() => backfillRange(["--from", "nope"])).toThrow(/date/);
  });
});

describe("runFeatureBackfill (test DB, fake Coinbase)", () => {
  it("stores candles and writes one row per closed 4h bar, nothing at or after the end", async () => {
    const { pool } = await import("../../../db/pool");
    const { runFeatureBackfill } = await import("../featureBackfill");
    const symbol = `T${Math.random().toString(36).slice(2, 8).toUpperCase()}-USD`;
    const end = utc("2019-03-01");
    const fetchPage = async (_p: string, g: string, start: number, stop: number): Promise<OHLCEntry[]> => {
      const sec = g === "ONE_HOUR" ? 3_600 : 86_400;
      const out: OHLCEntry[] = [];
      for (let t = Math.max(start, utc("2019-01-01")); t <= stop; t += sec) {
        const px = 4_000 + Math.sin(t / 50_000) * 200;
        out.push({ time: t, open: String(px), high: String(px + 20), low: String(px - 20), close: String(px + 5), volume: "10" });
      }
      return out;
    };
    try {
      const s = await runFeatureBackfill({ from: utc("2019-02-01"), toExclusive: end, symbol, fetchPage, sleepMs: 0 });
      expect(s.rows).toBe(28 * 6);
      expect(s.first).toBe(utc("2019-02-01"));
      expect(s.last).toBe(end - 14_400);
      const { rows } = await pool.query(
        `SELECT (SELECT count(*)::int FROM feature_candles WHERE symbol = $1 AND ts >= to_timestamp($2)) AS late_candles,
                (SELECT count(*)::int FROM setup_features WHERE symbol = $1 AND bar_time >= to_timestamp($2)) AS late_rows,
                (SELECT count(*)::int FROM setup_features WHERE symbol = $1 AND origin = 'backfill') AS rows`,
        [symbol, end],
      );
      expect(rows[0]).toEqual({ late_candles: 0, late_rows: 0, rows: 168 });
      // short history: weekly SMA 200 is warm-up, RSI 4h is real
      expect(s.nullCounts.t_w_sma200_dist).toBe(168);
      expect(s.nullCounts.m_rsi14_4h ?? 0).toBe(0);
    } finally {
      await pool.query(`DELETE FROM feature_candles WHERE symbol = $1`, [symbol]);
      await pool.query(`DELETE FROM setup_features WHERE symbol = $1`, [symbol]);
    }
  });
});
