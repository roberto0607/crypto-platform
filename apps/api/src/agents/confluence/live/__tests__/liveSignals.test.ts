/**
 * Live-only feature inputs: Kraken book imbalance, real CVD from the
 * footprint, and the news gate.
 */
import { describe, it, expect, afterAll } from "vitest";
import { pool } from "../../../../db/pool";
import { bookImbalanceFrom, footprintBarFlow, realCvdAt, readNewsGate, BOOK_MAX_AGE_MS } from "../liveSignals";

const H4 = 14_400;
const utc = (iso: string) => Date.parse(iso) / 1000;

describe("bookImbalanceFrom", () => {
  const snap = (bid: number, ask: number, ts: number) => ({ timestamp: ts, kraken: { totalBidDollars: bid, totalAskDollars: ask } });

  it("is (bid − ask) ÷ (bid + ask) of the Kraken depth within ±1% of mid", () => {
    expect(bookImbalanceFrom(snap(300, 100, 1_000), 1_000)).toEqual({ value: 0.5, reason: "" });
    expect(bookImbalanceFrom(snap(100, 300, 1_000), 1_000).value).toBe(-0.5);
  });

  it("is NULL when there is no reading, it is over 60 s old, or the book is empty", () => {
    expect(bookImbalanceFrom(null, 1_000)).toEqual({ value: null, reason: "unavailable" });
    expect(bookImbalanceFrom(snap(1, 1, 0), BOOK_MAX_AGE_MS)).toEqual({ value: 0, reason: "" });
    expect(bookImbalanceFrom(snap(1, 1, 0), BOOK_MAX_AGE_MS + 1)).toEqual({ value: null, reason: "stale" });
    expect(bookImbalanceFrom(snap(0, 0, 0), 0)).toEqual({ value: null, reason: "empty" });
  });
});

describe("realCvdAt", () => {
  const close = utc("2026-11-20T00:00:00Z");
  /** One point per 4h bar ending at `close`, stamped at the bar's open. */
  const bars = (n: number, delta: number, volume: number, skip: number[] = []) => {
    const d = [];
    const v = [];
    for (let i = n; i >= 1; i--) {
      if (skip.includes(i)) continue;
      d.push({ time: close - i * H4, value: delta });
      v.push({ time: close - i * H4, value: volume });
    }
    return { d, v };
  };

  it("is net delta ÷ volume over the 6 and 42 bars closed by the close", () => {
    const { d, v } = bars(50, 2, 10);
    const r = realCvdAt(close, d, v);
    expect(r.values.f_cvd_real_24h).toBeCloseTo(0.2, 12);
    expect(r.values.f_cvd_real_7d).toBeCloseTo(0.2, 12);
    expect(r.missing).toEqual({});
  });

  it("ignores bars that close after the close", () => {
    const { d, v } = bars(50, 1, 10);
    d.push({ time: close, value: 999 });
    v.push({ time: close, value: 1 });
    expect(realCvdAt(close, d, v).values.f_cvd_real_24h).toBeCloseTo(0.1, 12);
  });

  it("is warm-up before the window's start and NULL on coverage under 90%", () => {
    const short = bars(10, 1, 10);
    const r = realCvdAt(close, short.d, short.v);
    expect(r.values.f_cvd_real_24h).toBeCloseTo(0.1, 12);
    expect(r.values.f_cvd_real_7d).toBeNull();
    expect(r.missing.f_cvd_real_7d).toBe("warmup");

    const holes = bars(50, 1, 10, [2, 30, 31, 32, 33, 34]);
    const h = realCvdAt(close, holes.d, holes.v);
    expect(h.values.f_cvd_real_24h).toBeNull(); // 5 of 6
    expect(h.missing.f_cvd_real_24h).toBe("coverage");
    expect(h.values.f_cvd_real_7d).toBeNull(); // 36 of 42 < 37.8
    expect(h.missing.f_cvd_real_7d).toBe("coverage");
  });
});

describe("footprintBarFlow (test DB)", () => {
  const pair = `T${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
  afterAll(async () => {
    await pool.query(`DELETE FROM footprint_candles WHERE pair = $1`, [pair]);
  });

  it("sums the 16 15m candles of a 4h bar, and is null if any is missing", async () => {
    const bar = utc("2001-01-01T04:00:00Z");
    for (let i = 0; i < 16; i++) {
      const open = bar + i * 900;
      await pool.query(
        `INSERT INTO footprint_candles (pair, timeframe, open_time, close_time, total_buy_qty, total_sell_qty, delta)
         VALUES ($1, '15m', to_timestamp($2), to_timestamp($3), 3, 1, 2)`,
        [pair, open, open + 899],
      );
    }
    // a 5m candle and a candle of the next bar don't count
    await pool.query(
      `INSERT INTO footprint_candles (pair, timeframe, open_time, close_time, total_buy_qty, total_sell_qty, delta)
       VALUES ($1, '5m', to_timestamp($2), to_timestamp($2 + 299), 100, 0, 100), ($1, '15m', to_timestamp($3), to_timestamp($3 + 899), 100, 0, 100)`,
      [pair, bar, bar + H4],
    );
    expect(await footprintBarFlow(bar, pair)).toEqual({ delta: 32, volume: 64 });
    await pool.query(`DELETE FROM footprint_candles WHERE pair = $1 AND open_time = to_timestamp($2) AND timeframe = '15m'`, [pair, bar]);
    expect(await footprintBarFlow(bar, pair)).toBeNull();
  });
});

describe("readNewsGate (test DB)", () => {
  it("is NULL when the News Agent is off", async () => {
    expect(await readNewsGate({ enabled: false, symbol: "BTC/USD", atSec: 0 })).toEqual({ value: null, reason: "news_agent_off" });
  });

  it("is true only while a negative flag is unexpired", async () => {
    const { rows } = await pool.query<{ id: string }>(`SELECT id FROM trading_pairs WHERE symbol = 'BTC/USD'`);
    const pairId = rows[0]!.id;
    const before = await pool.query(`SELECT * FROM pair_news_flags WHERE pair_id = $1`, [pairId]);
    const now = Math.floor(Date.now() / 1000);
    try {
      await pool.query(
        `INSERT INTO pair_news_flags (pair_id, flagged_negative, reason, expires_at, updated_at)
         VALUES ($1, true, 'test', to_timestamp($2), now())
         ON CONFLICT (pair_id) DO UPDATE SET flagged_negative = true, expires_at = EXCLUDED.expires_at`,
        [pairId, now + 600],
      );
      expect(await readNewsGate({ enabled: true, symbol: "BTC/USD", atSec: now })).toEqual({ value: true, reason: "" });
      expect(await readNewsGate({ enabled: true, symbol: "BTC/USD", atSec: now + 601 })).toEqual({ value: false, reason: "" });
      await pool.query(`UPDATE pair_news_flags SET flagged_negative = false WHERE pair_id = $1`, [pairId]);
      expect(await readNewsGate({ enabled: true, symbol: "BTC/USD", atSec: now })).toEqual({ value: false, reason: "" });
      expect(await readNewsGate({ enabled: true, symbol: "NOPE/USD", atSec: now })).toEqual({ value: null, reason: "no_pair" });
    } finally {
      await pool.query(`DELETE FROM pair_news_flags WHERE pair_id = $1`, [pairId]);
      const b = before.rows[0];
      if (b) {
        await pool.query(
          `INSERT INTO pair_news_flags (pair_id, flagged_negative, reason, source_headline, expires_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6)`,
          [pairId, b.flagged_negative, b.reason, b.source_headline, b.expires_at, b.updated_at],
        );
      }
    }
  });
});
