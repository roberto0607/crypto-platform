/**
 * computeIndicatorSnapshot (the agents' indicator snapshot) — loads enough
 * history for each requested indicator, never reads a forming bar, and
 * computes VWAP from the start of the UTC day. Real test DB.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll } from "vitest";
import { pool } from "../../../db/pool";
import { ensureMigrations } from "../../../testing/resetDb";
import { createCandleFixturePair, insertCandles, type Row } from "../../../testing/candleFixtures";
import { computeIndicatorSnapshot } from "../v1Market";
import { computeEMA, computeRSI, computeVWAP, computeVolumeProfile, computeCVD, type Candle } from "../../../indicators";

const HOUR_MS = 3_600_000;
const MIN_MS = 60_000;

/** A wandering price path, so EMA seeds differ visibly from the converged value. */
function rows(fromMs: number, count: number, stepMs: number): Row[] {
    const out: Row[] = [];
    for (let k = 0; k < count; k++) {
        // Rounded to cents: the candles columns are fixed-scale numerics.
        const o = Math.round((1000 + 400 * Math.sin(k / 97) + k * 0.3 + (k % 5)) * 100) / 100;
        out.push({ tsMs: fromMs + k * stepMs, open: o, high: o + 4 + (k % 3), low: o - 3 - (k % 4), close: o + 1 - (k % 2) * 2, volume: 1 + (k % 9) });
    }
    return out;
}

function toCandles(rs: Row[]): Candle[] {
    return rs.map((r) => ({ time: r.tsMs / 1000, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume }));
}

const last = <T extends { value: number }>(p: T[]) => p[p.length - 1]!.value;

describe("computeIndicatorSnapshot history", () => {
    let fx: Awaited<ReturnType<typeof createCandleFixturePair>>;

    beforeAll(async () => {
        await ensureMigrations();
    });
    beforeEach(async () => {
        fx = await createCandleFixturePair(pool, "IS");
    });
    afterEach(async () => {
        await fx.cleanup();
    });

    it("EMA 200 uses enough history to converge (not just 300 bars)", async () => {
        const start = Date.UTC(2025, 0, 1);
        const data = rows(start, 2500, HOUR_MS);
        await insertCandles(pool, fx.pairId, "1h", data);
        const nowMs = start + 2500 * HOUR_MS; // every row is closed

        const snap = await computeIndicatorSnapshot(fx.pairId, "1h", ["ema200", "ema20"], { nowMs });
        const full = last(computeEMA(toCandles(data), 200));
        const from300 = last(computeEMA(toCandles(data.slice(-300)), 200));
        expect(Math.abs(full - from300)).toBeGreaterThan(1); // the old 300-bar window is visibly off
        expect(snap.indicators.ema200 as number).toBeCloseTo(full, 3);
        expect(snap.indicators.ema20 as number).toBeCloseTo(last(computeEMA(toCandles(data), 20)), 9);
    });

    it("drops a forming bar: asOf and values come from closed bars only", async () => {
        const start = Date.UTC(2025, 0, 1);
        const data = rows(start, 400, HOUR_MS);
        await insertCandles(pool, fx.pairId, "1h", data);
        // 'now' is 30 minutes into the last row's hour → that row is still forming.
        const nowMs = data[data.length - 1]!.tsMs + 30 * MIN_MS;

        const snap = await computeIndicatorSnapshot(fx.pairId, "1h", ["rsi"], { nowMs });
        const closed = data.slice(0, -1);
        expect(snap.asOf).toBe(closed[closed.length - 1]!.tsMs / 1000);
        // 6 digits: the snapshot loads 20×14 bars, so a ~1e-8 seed residual remains.
        expect(snap.indicators.rsi as number).toBeCloseTo(last(computeRSI(toCandles(closed))), 6);
    });

    it("drops a forming 1w bar (Monday-anchored bucket not yet ended)", async () => {
        const monday = Date.UTC(2024, 0, 1); // a Monday
        const data = rows(monday, 60, 7 * 24 * HOUR_MS);
        await insertCandles(pool, fx.pairId, "1w", data);
        const nowMs = data[data.length - 1]!.tsMs + 3 * 24 * HOUR_MS; // Thursday of the last week

        const snap = await computeIndicatorSnapshot(fx.pairId, "1w", ["rsi"], { nowMs });
        expect(snap.asOf).toBe(data[data.length - 2]!.tsMs / 1000);
    });

    it("1m VWAP starts at UTC midnight even when the day has more than 300 bars", async () => {
        const midnight = Date.UTC(2026, 0, 2);
        // 120 bars of the previous day, then 720 bars (12h) of today.
        const data = rows(midnight - 120 * MIN_MS, 840, MIN_MS);
        await insertCandles(pool, fx.pairId, "1m", data);
        const nowMs = midnight + 720 * MIN_MS;

        const snap = await computeIndicatorSnapshot(fx.pairId, "1m", ["vwap"], { nowMs });
        const today = data.filter((r) => r.tsMs >= midnight);
        const expected = last(computeVWAP(toCandles(today)));
        expect(Math.abs(expected - last(computeVWAP(toCandles(data.slice(-300)))))).toBeGreaterThan(0.01);
        expect(snap.indicators.vwap as number).toBeCloseTo(expected, 9);
    });

    it("window-defined indicators (VPVR, CVD) stay on the last 300 closed bars", async () => {
        const start = Date.UTC(2025, 0, 1);
        const data = rows(start, 2500, HOUR_MS);
        await insertCandles(pool, fx.pairId, "1h", data);
        const nowMs = start + 2500 * HOUR_MS;

        const snap = await computeIndicatorSnapshot(fx.pairId, "1h", ["ema200", "vpvr", "cvd"], { nowMs });
        const window = toCandles(data.slice(-300));
        const profile = computeVolumeProfile(window)!;
        expect(snap.indicators.vpvr).toEqual({ poc: profile.poc, vah: profile.vah, val: profile.val });
        const cvd = computeCVD(window);
        expect(snap.indicators.cvd).toEqual({ value: last(cvd.values), dataSource: cvd.dataSource });
    });
});
