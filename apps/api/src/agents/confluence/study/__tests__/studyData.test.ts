/**
 * The study loader against the test DB: in-sample only, backfill rows only,
 * and nothing at or after the window's end is read.
 */
import { describe, it, expect, afterAll } from "vitest";
import { pool } from "../../../../db/pool";
import { upsertFeatureCandles } from "../../featureCandleRepo";
import { upsertFeatureRows } from "../../setupFeatureRepo";
import { loadStudyData, studyWindow } from "../studyData";

const H = 3_600;
const H4 = 14_400;
const utc = (d: string) => Date.parse(`${d}T00:00:00Z`) / 1000;
const symbol = `T${Math.random().toString(36).slice(2, 8).toUpperCase()}-USD`;

afterAll(async () => {
  await pool.query(`DELETE FROM setup_features WHERE symbol = $1`, [symbol]);
  await pool.query(`DELETE FROM feature_candles WHERE symbol = $1`, [symbol]);
});

describe("studyWindow", () => {
  it("defaults to the in-sample window and refuses anything past 2024-01-01", () => {
    expect(studyWindow()).toEqual({ from: utc("2019-05-19"), toExclusive: utc("2024-01-01") });
    expect(studyWindow({ from: "2019-05-19", toExclusive: "2022-01-01" })).toEqual({ from: utc("2019-05-19"), toExclusive: utc("2022-01-01") });
    expect(() => studyWindow({ toExclusive: "2024-01-02" })).toThrow(/out of sample/);
    expect(() => studyWindow({ from: "2024-01-01", toExclusive: "2024-01-01" })).toThrow();
  });
});

describe("loadStudyData (test DB)", () => {
  it("loads backfill rows and candles inside the window, nothing at or after its end", async () => {
    const start = utc("2023-12-20");
    const end = utc("2023-12-25");
    const h1 = [];
    for (let t = start - 2 * 86_400; t < end + 3 * 86_400; t += H) h1.push({ time: t, open: 100, high: 101, low: 99, close: 100, volume: 1 });
    await upsertFeatureCandles(symbol, "1h", h1);
    const row = (barTime: number, rsi: number) => ({
      barTime, closeTime: barTime + H4, close: 100, atr14_4h: 2, values: { m_rsi14_4h: rsi }, missing: {},
    });
    const inside = [start, start + H4, end - H4];
    await upsertFeatureRows(symbol, "backfill", [...inside.map((t) => row(t, 50)), row(end, 99), row(end + H4, 99)]);
    await upsertFeatureRows(symbol, "live", [row(start + 2 * H4, 77)]);

    const data = await loadStudyData({ from: start, toExclusive: end }, symbol);
    expect(data.rows.map((r) => r.barTime)).toEqual(inside);
    expect(data.rows.every((r) => r.values.m_rsi14_4h === 50)).toBe(true);
    expect(data.rows[0]!.atr).toBe(2);
    expect(data.rows[0]!.year).toBe(2023);
    // candles: only bars closed by the end
    expect(data.h4.at(-1)!.time + H4).toBe(end);
    expect(data.h4[data.rows[1]!.k]!.time).toBe(start + H4);
  });
});
