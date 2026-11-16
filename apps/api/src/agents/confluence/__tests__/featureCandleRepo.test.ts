/**
 * feature_candles against the real test Postgres. Each
 * test uses its own symbol so nothing else's rows are touched.
 */
import { describe, it, expect, afterAll } from "vitest";
import { pool } from "../../../db/pool";
import { loadFeatureCandles, upsertFeatureCandles } from "../featureCandleRepo";

const symbols: string[] = [];
const sym = () => {
  const s = `T${Math.random().toString(36).slice(2, 8).toUpperCase()}-USD`;
  symbols.push(s);
  return s;
};

afterAll(async () => {
  await pool.query(`DELETE FROM feature_candles WHERE symbol = ANY($1)`, [symbols]);
});

describe("feature candles", () => {
  it("upserts (replacing a bar in place) and loads only bars closed by the end instant, ascending", async () => {
    const s = sym();
    const c = (time: number, close: number) => ({ time, open: 1, high: 2, low: 0.5, close, volume: 3 });
    expect(await upsertFeatureCandles(s, "1h", [c(7_200, 1), c(0, 1), c(3_600, 1)])).toBe(3);
    await upsertFeatureCandles(s, "1h", [c(3_600, 9)]);
    expect(await loadFeatureCandles(s, "1h", 7_200)).toEqual([c(0, 1), c(3_600, 9)]);
    expect((await loadFeatureCandles(s, "1h", 10_800)).length).toBe(3);
    expect(await loadFeatureCandles(s, "1d", 10_800)).toEqual([]);
  });
});
