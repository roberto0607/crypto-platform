/**
 * external_series storage and the external backfill against the test
 * Postgres, with a fake HTTP layer. Each test uses its own series prefix /
 * symbol so nothing else's rows are touched.
 */
import { describe, it, expect, afterAll } from "vitest";
import { pool } from "../../../../db/pool";
import { loadExternalSeries, storeExternalSeries } from "../externalSeriesRepo";
import { runExternalBackfill, SERIES } from "../externalBackfill";
import { runFeatureBackfill } from "../../featureBackfill";
import type { Http } from "../http";
import type { OHLCEntry } from "../../../../marketData/coinbaseRest";

const utc = (iso: string) => Date.parse(iso) / 1000;
const prefixes: string[] = [];
const prefix = () => {
  const p = `t${Math.random().toString(36).slice(2, 8)}_`;
  prefixes.push(p);
  return p;
};

afterAll(async () => {
  for (const p of prefixes) await pool.query(`DELETE FROM external_series WHERE series LIKE $1`, [`${p}%`]);
});

describe("storeExternalSeries", () => {
  const five = Array.from({ length: 36 }, (_, i) => ({ time: utc("2021-01-01T00:00:00Z") + i * 300, value: i }));

  it("at 1h resolution keeps the last point of each hour; 'full' keeps every point", async () => {
    const p = prefix();
    expect(await storeExternalSeries(`${p}oi`, five, "1h")).toBe(3);
    expect(await loadExternalSeries(`${p}oi`, 0, utc("2030-01-01T00:00:00Z"))).toEqual([
      { time: utc("2021-01-01T00:55:00Z"), value: 11 },
      { time: utc("2021-01-01T01:55:00Z"), value: 23 },
      { time: utc("2021-01-01T02:55:00Z"), value: 35 },
    ]);
    expect(await storeExternalSeries(`${p}full`, five, "full")).toBe(36);
  });

  it("is idempotent (a re-run replaces values in place) and loads [from, to) ascending", async () => {
    const p = prefix();
    await storeExternalSeries(`${p}x`, [{ time: 100, value: 1 }, { time: 7_300, value: 2 }], "1h");
    await storeExternalSeries(`${p}x`, [{ time: 7_300, value: 9 }], "1h");
    expect(await loadExternalSeries(`${p}x`, 0, 7_300)).toEqual([{ time: 100, value: 1 }]);
    expect(await loadExternalSeries(`${p}x`, 0, 7_301)).toEqual([{ time: 100, value: 1 }, { time: 7_300, value: 9 }]);
  });
});

/** Fake sources: hourly funding, 5-minute OI days, daily F&G; records every URL. */
function fakeHttp(urls: string[]): Http {
  const zipOf = async (day: string) => {
    const { makeMetricsZip } = await import("./zipFixture");
    return makeMetricsZip(day);
  };
  return {
    json: async (url) => {
      urls.push(url);
      const u = new URL(url);
      if (u.hostname.includes("deribit")) {
        const s = Number(u.searchParams.get("start_timestamp"));
        const e = Number(u.searchParams.get("end_timestamp"));
        const result = [];
        for (let t = Math.max(s, Date.parse("2019-01-01T00:00:00Z")); t <= e; t += 3_600_000) result.push({ timestamp: t, interest_8h: 1e-4 });
        return { result };
      }
      if (u.hostname.includes("alternative.me")) {
        const data = [];
        for (let t = utc("2018-02-01T00:00:00Z"); t < utc("2026-11-17T00:00:00Z"); t += 86_400) data.push({ value: "50", timestamp: String(t) });
        return { data };
      }
      throw new Error(`unexpected ${url}`);
    },
    buffer: async (url) => {
      urls.push(url);
      const day = /metrics-(\d{4}-\d{2}-\d{2})\.zip/.exec(url)![1]!;
      const zip = await zipOf(day);
      if (url.endsWith(".CHECKSUM")) {
        const { createHash } = await import("node:crypto");
        return Buffer.from(`${createHash("sha256").update(zip).digest("hex")}  BTCUSDT-metrics-${day}.zip\n`);
      }
      return zip;
    },
  };
}

describe("runExternalBackfill", () => {
  it("fills funding, Binance OI and F&G over the range, nothing at or after its end; Gate.io/OKX aren't fetched (no in-sample history)", async () => {
    const p = prefix();
    const urls: string[] = [];
    const from = utc("2020-09-01T00:00:00Z");
    const to = utc("2020-09-04T00:00:00Z");
    const r = await runExternalBackfill({ from, toExclusive: to, http: fakeHttp(urls), seriesPrefix: p, resolution: "1h", sleepMs: 0 });
    expect(urls.some((u) => /gateio|okx/.test(u))).toBe(false);
    // funding from a year + 8 days before `from` (rank window), OI from 8 days before (7d change)
    expect(r.counts[SERIES.funding]).toBe((to - (from - 373 * 86_400)) / 3_600);
    expect(r.counts[SERIES.binanceOi]).toBe(3 * 24);
    // the archive starts 2020-09-01: days before it are never requested
    expect(urls.filter((u) => u.includes("binance")).every((u) => !/2020-08-/.test(u))).toBe(true);
    expect(r.binanceMissingDays).toEqual([]);
    const { rows } = await pool.query(
      `SELECT series, count(*)::int AS n, max(ts) AS last FROM external_series WHERE series LIKE $1 GROUP BY 1 ORDER BY 1`, [`${p}%`],
    );
    for (const row of rows) expect(new Date(row.last).getTime() / 1000).toBeLessThan(to);
  });
});

describe("runFeatureBackfill with external series", () => {
  it("fills funding / OI / F&G columns from the stored series, as of each 4h close", async () => {
    const p = prefix();
    const symbol = `T${Math.random().toString(36).slice(2, 8).toUpperCase()}-USD`;
    const urls: string[] = [];
    const from = utc("2020-09-10T00:00:00Z");
    const to = utc("2020-09-12T00:00:00Z");
    await runExternalBackfill({ from, toExclusive: to, http: fakeHttp(urls), seriesPrefix: p, resolution: "1h", sleepMs: 0 });
    const fetchPage = async (_p: string, g: string, start: number, stop: number): Promise<OHLCEntry[]> => {
      const sec = g === "ONE_HOUR" ? 3_600 : 86_400;
      const out: OHLCEntry[] = [];
      for (let t = Math.max(start, utc("2020-06-01T00:00:00Z")); t <= stop; t += sec) out.push({ time: t, open: "10000", high: "10100", low: "9900", close: "10050", volume: "5" });
      return out;
    };
    try {
      const s = await runFeatureBackfill({ from, toExclusive: to, symbol, fetchPage, sleepMs: 0, seriesPrefix: p });
      expect(s.rows).toBe(12);
      const { rows } = await pool.query(
        `SELECT p_funding_8h, p_funding_avg_7d, p_oi_usd, p_oi_chg_24h, s_fng, missing FROM setup_features WHERE symbol = $1 ORDER BY bar_time`, [symbol],
      );
      expect(rows[0].p_funding_8h).toBe(1e-4);
      expect(rows[0].p_funding_avg_7d).toBeCloseTo(1e-4, 12);
      expect(rows[0].p_oi_usd).not.toBeNull();
      expect(rows[0].p_oi_chg_24h).not.toBeNull();
      expect(rows[0].s_fng).toBe(50);
      expect(rows[0].missing.p_funding_8h).toBeUndefined();
      // the OI fetch starts 8 days before `from`, so the 7d change is defined from the first row
      expect(rows[0].p_oi_chg_7d).not.toBeNull();
    } finally {
      await pool.query(`DELETE FROM feature_candles WHERE symbol = $1`, [symbol]);
      await pool.query(`DELETE FROM setup_features WHERE symbol = $1`, [symbol]);
    }
  });
});
