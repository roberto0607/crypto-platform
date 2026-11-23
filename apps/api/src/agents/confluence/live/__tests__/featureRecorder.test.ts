/**
 * The live feature recorder against the test DB, with fake Coinbase,
 * Deribit, Gate.io, OKX and Fear & Greed, a fake book, news gate and
 * footprint. Each test uses its own symbol and series prefix.
 */
import { describe, it, expect, afterAll } from "vitest";
import { pool } from "../../../../db/pool";
import type { OHLCEntry } from "../../../../marketData/coinbaseRest";
import type { Http } from "../../external/http";
import { runFeatureRecorder, RECORDER, type RecorderOptions } from "../featureRecorder";
import { computeBackfillRows } from "../../featureBackfill";
import { loadFeatureCandles } from "../../featureCandleRepo";
import { prepareExternal } from "../../external/externalFeatures";
import { loadExternalSeries } from "../../external/externalSeriesRepo";
import { combineOi } from "../../external/gateOkxOi";
import { SERIES } from "../../external/externalBackfill";
import { FLOW_SERIES } from "../liveSignals";
import { FEATURE_COLUMNS } from "../../featureColumns";

const H = 3_600;
const H4 = 14_400;
const D = 86_400;
const utc = (iso: string) => Date.parse(iso) / 1000;
const HISTORY = utc("2026-08-01T00:00:00Z");
const CLOSE = utc("2026-11-20T08:00:00Z");

const fetchPage = async (_p: string, g: string, start: number, stop: number): Promise<OHLCEntry[]> => {
  const sec = g === "ONE_HOUR" ? H : D;
  const out: OHLCEntry[] = [];
  for (let t = Math.max(start, HISTORY); t <= stop; t += sec) {
    const px = 90_000 + Math.sin(t / 200_000) * 3_000 + Math.cos(t / 37_000) * 500;
    out.push({ time: t, open: String(px), high: String(px + 150), low: String(px - 140), close: String(px + 20), volume: String(50 + (t / H) % 7) });
  }
  return out;
};

/** Fake external APIs; `fail` names sources that throw. */
const fakeHttp = (nowSec: number, fail: string[] = []): Http => ({
  async json(url: string) {
    const u = new URL(url);
    const q = (k: string) => Number(u.searchParams.get(k));
    if (u.hostname.includes("deribit")) {
      if (fail.includes("funding")) throw new Error("deribit down");
      const result = [];
      for (let t = Math.ceil(q("start_timestamp") / 3.6e6) * 3_600; t * 1000 <= q("end_timestamp") && t <= nowSec; t += H) {
        result.push({ timestamp: t * 1000, interest_8h: 0.0001 + 0.00005 * Math.sin(t / 90_000) });
      }
      return { result };
    }
    if (u.hostname.includes("gateio")) {
      if (fail.includes("gate")) throw new Error("gate down");
      const rows = [];
      for (let t = q("from"), n = 0; t <= nowSec && n < q("limit"); t += H, n++) rows.push({ time: t, open_interest_usd: 3e9 + 1e8 * Math.sin(t / 300_000) });
      return rows;
    }
    if (u.hostname.includes("okx")) {
      const data = [];
      const step = u.searchParams.get("period") === "1D" ? D : H;
      const end = step === D ? Math.floor((nowSec - 16 * H) / D) * D + 16 * H : Math.floor(nowSec / H) * H;
      for (let t = end, n = 0; n < (step === D ? 180 : 720); t -= step, n++) data.push([String(t * 1000), String(2e9 + 5e7 * Math.cos(t / 250_000)), "0"]);
      return { data };
    }
    if (u.hostname.includes("alternative.me")) {
      const data = [];
      for (let t = utc("2026-01-01T00:00:00Z"); t <= nowSec; t += D) data.push({ value: String(40 + ((t / D) % 20)), timestamp: String(t) });
      return { data: data.reverse() };
    }
    throw new Error(`unexpected ${url}`);
  },
  async buffer() {
    throw new Error("no buffers");
  },
});

const symbols: string[] = [];
const prefixes: string[] = [];
const fresh = () => {
  const id = Math.random().toString(36).slice(2, 8).toUpperCase();
  symbols.push(`T${id}-USD`);
  prefixes.push(`t_${id}_`);
  return { symbol: `T${id}-USD`, seriesPrefix: `t_${id}_` };
};

afterAll(async () => {
  await pool.query(`DELETE FROM setup_features WHERE symbol = ANY($1)`, [symbols]);
  await pool.query(`DELETE FROM feature_candles WHERE symbol = ANY($1)`, [symbols]);
  for (const p of prefixes) await pool.query(`DELETE FROM external_series WHERE series LIKE $1`, [`${p}%`]);
});

const opts = (ids: { symbol: string; seriesPrefix: string }, nowSec: number, over: Partial<RecorderOptions> = {}): RecorderOptions => ({
  ...ids,
  nowSec,
  historyStart: HISTORY,
  resolution: "1h",
  http: fakeHttp(nowSec),
  fetchPage,
  sleepMs: 0,
  paused: () => false,
  bookSnapshot: () => ({ timestamp: nowSec * 1000 - 5_000, kraken: { totalBidDollars: 300, totalAskDollars: 100 } }),
  newsGate: async () => ({ value: false, reason: "" }),
  footprintFlow: async () => ({ delta: 2, volume: 10 }),
  ...over,
});

const rowsOf = async (symbol: string) =>
  (await pool.query(`SELECT *, extract(epoch FROM bar_time)::bigint::int AS bt FROM setup_features WHERE symbol = $1 ORDER BY bar_time`, [symbol])).rows;

describe("runFeatureRecorder", () => {
  it("records the bar that just closed, the same as the backfill path, plus the live columns", async () => {
    const ids = fresh();
    const now = CLOSE + RECORDER.delaySec + 60;
    const s = await runFeatureRecorder(opts(ids, now));
    expect(s.status).toBe("recorded");
    expect(s.sourceErrors).toEqual([]);
    const rows = await rowsOf(ids.symbol);
    // first run: it also catches up the bars of the last 7 days
    expect(rows).toHaveLength(RECORDER.catchUpBars);
    const r = rows[rows.length - 1];
    expect(r.bt).toBe(CLOSE - H4);
    expect(r.origin).toBe("live");
    expect(r.recorded_late).toBe(false);
    expect(r.f_book_imbalance).toBe(0.5);
    expect(r.e_news_gate).toBe(false);
    expect(r.f_cvd_real_24h).toBeCloseTo(0.2, 12);
    expect(r.f_cvd_real_7d).toBeNull();
    expect(r.missing.f_cvd_real_7d).toBe("warmup");
    expect(r.p_funding_8h).not.toBeNull();
    expect(r.p_oi_usd).not.toBeNull();
    expect(r.s_fng).not.toBeNull();

    // parity: candle, event and external columns equal the backfill path on the same stored data
    const h1 = await loadFeatureCandles(ids.symbol, "1h", CLOSE);
    const d1 = await loadFeatureCandles(ids.symbol, "1d", CLOSE);
    const load = (n: string) => loadExternalSeries(ids.seriesPrefix + n, 0, CLOSE + 1);
    const ext = prepareExternal({
      funding: await load(SERIES.funding),
      oi: combineOi(await load(SERIES.gateOi), await load(SERIES.okxOi)),
      fng: await load(SERIES.fng),
    });
    const expected = computeBackfillRows(h1, d1, CLOSE - H4, CLOSE, ext)[0]!;
    for (const c of FEATURE_COLUMNS) {
      if (c.source === "live") continue;
      expect([c.name, r[c.name]]).toEqual([c.name, (expected.values as Record<string, unknown>)[c.name] ?? null]);
      if (r[c.name] === null) expect([c.name, r.missing[c.name]]).toEqual([c.name, expected.missing[c.name]]);
    }

    // the 4h Kraken flow is kept, since footprint_candles only keeps 24 hours
    const flow = await loadExternalSeries(ids.seriesPrefix + FLOW_SERIES.delta, 0, CLOSE);
    expect(flow.map((p) => p.time)).toEqual([0, 1, 2, 3, 4, 5].map((i) => CLOSE - 24 * H + i * H4));
  });

  it("is idempotent: a second run at the same close changes nothing", async () => {
    const ids = fresh();
    const now = CLOSE + RECORDER.delaySec + 60;
    await runFeatureRecorder(opts(ids, now));
    const before = await rowsOf(ids.symbol);
    const again = await runFeatureRecorder(opts(ids, now + 120, { bookSnapshot: () => null }));
    expect(again.status).toBe("idle");
    expect(await rowsOf(ids.symbol)).toEqual(before);
  });

  it("waits 5 minutes after the close", async () => {
    const ids = fresh();
    const s = await runFeatureRecorder(opts(ids, CLOSE + RECORDER.delaySec - 1));
    const rows = await rowsOf(ids.symbol);
    expect(s.status).toBe("recorded");
    expect(rows[rows.length - 1].bt).toBe(CLOSE - 2 * H4);
  });

  it("marks rows over 30 minutes late, and leaves book and news NULL on them", async () => {
    const ids = fresh();
    await runFeatureRecorder(opts(ids, CLOSE + RECORDER.delaySec));
    const s = await runFeatureRecorder(opts(ids, CLOSE + 2 * H4 + 20 * 60)); // missed the next close, on time for the one after
    expect(s.rows.map((r) => [r.barTime, r.late])).toEqual([[CLOSE, true], [CLOSE + H4, false]]);
    const rows = await rowsOf(ids.symbol);
    const late = rows.find((r) => r.bt === CLOSE)!;
    expect(late.recorded_late).toBe(true);
    expect(late.f_book_imbalance).toBeNull();
    expect(late.missing.f_book_imbalance).toBe("late");
    expect(late.e_news_gate).toBeNull();
    expect(late.missing.e_news_gate).toBe("late");
    expect(late.p_funding_8h).not.toBeNull();
    const onTime = rows.find((r) => r.bt === CLOSE + H4)!;
    expect(onTime.recorded_late).toBe(false);
    expect(onTime.f_book_imbalance).toBe(0.5);
  });

  it("still writes the row when a source fails, with that source's columns NULL", async () => {
    const ids = fresh();
    const now = CLOSE + RECORDER.delaySec;
    const s = await runFeatureRecorder(opts(ids, now, {
      http: fakeHttp(now, ["funding", "gate"]),
      footprintFlow: async () => { throw new Error("db"); },
      bookSnapshot: () => null,
    }));
    expect(s.sourceErrors.sort()).toEqual(["footprint", "funding", "gate"]);
    const r = (await rowsOf(ids.symbol)).at(-1)!;
    expect(r.bt).toBe(CLOSE - H4);
    for (const c of ["p_funding_8h", "p_funding_avg_7d", "p_funding_rank_1y", "p_oi_usd", "p_oi_chg_24h", "p_oi_chg_7d", "f_cvd_real_24h"]) {
      expect([c, r[c], r.missing[c]]).toEqual([c, null, "source_error"]);
    }
    expect(r.missing.f_book_imbalance).toBe("unavailable");
    expect(r.s_fng).not.toBeNull();
    expect(r.m_rsi14_4h).not.toBeNull();
  });

  it("does nothing while the DB-size guardrail pauses non-essential writes", async () => {
    const ids = fresh();
    const s = await runFeatureRecorder(opts(ids, CLOSE + RECORDER.delaySec, { paused: () => true }));
    expect(s.status).toBe("paused");
    expect(await rowsOf(ids.symbol)).toEqual([]);
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM feature_candles WHERE symbol = $1`, [ids.symbol]);
    expect(rows[0].n).toBe(0);
  });
});
