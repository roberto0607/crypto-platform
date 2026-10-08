/**
 * rerollCandles.test.ts — one-time frozen-bucket repair, per timeframe,
 * against the real test DB: plan (dry run) writes nothing; apply replaces
 * frozen rows and inserts missing ones from complete 1m history only; never
 * touches incomplete or still-settling buckets; idempotent; revert restores.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { pool } from "../../db/pool";
import { planReroll, applyReroll, revertReroll } from "../rerollCandles";
import { ROLLUPS } from "../../jobs/definitions/candleRollupJob";
import { createCandleFixturePair, insertCandles, minuteRows, aggregate, type Row } from "../../testing/candleFixtures";

const MONDAY = Date.UTC(2026, 8, 7); // ISO-week boundary (boundary for every timeframe)

describe.each(ROLLUPS.map((r) => [r.timeframe, r.minutes] as const))("reroll %s", (tf, minutes) => {
    const bMs = minutes * 60_000;
    const b = (i: number) => MONDAY + i * bMs;
    // b0 frozen · b1 correct · b2 missing · b3 incomplete · b4 ended < 15 min ago · b5 current
    // 10 min after b4 ends: b4 is inside the 15-min settle window, b3 just outside it.
    const now = b(5) + 10 * 60_000;
    let fx: Awaited<ReturnType<typeof createCandleFixturePair>>;
    let symbol: string;
    let oneMin: Row[];

    beforeEach(async () => {
        fx = await createCandleFixturePair(pool, "RR");
        const { rows } = await pool.query<{ symbol: string }>(`SELECT symbol FROM trading_pairs WHERE id = $1`, [fx.pairId]);
        symbol = rows[0]!.symbol;
        oneMin = minuteRows(b(0), now - 60_000).filter((r) => r.tsMs !== b(3) + 60_000); // gap in b3
        await insertCandles(pool, fx.pairId, "1m", oneMin);
        const agg = (i: number) => aggregate(oneMin.filter((r) => r.tsMs >= b(i) && r.tsMs < b(i + 1)));
        const wrong = { open: 1, high: 2, low: 0.5, close: 1.5, volume: 4 };
        await insertCandles(pool, fx.pairId, tf, [
            { tsMs: b(0), ...wrong },      // frozen
            { tsMs: b(1), ...agg(1) },     // correct
            { tsMs: b(3), ...wrong },      // incomplete 1m → can't judge
            { tsMs: b(4), ...wrong },      // still settling → the job's job
        ]);
    });
    afterEach(async () => {
        await fx.cleanup();
    });

    async function row(i: number) {
        const { rows } = await pool.query(
            `SELECT open::float o, high::float h, low::float l, close::float c, volume::float v
             FROM candles WHERE pair_id = $1 AND timeframe = $2 AND ts = to_timestamp($3 / 1000.0)`,
            [fx.pairId, tf, b(i)],
        );
        return rows[0] ? { open: rows[0].o, high: rows[0].h, low: rows[0].l, close: rows[0].c, volume: rows[0].v } : null;
    }
    const expected = (i: number) => aggregate(oneMin.filter((r) => r.tsMs >= b(i) && r.tsMs < b(i + 1)));

    it("dry-run plan: counts per series, writes nothing", async () => {
        const plan = await planReroll({ pool, symbols: [symbol], timeframes: [tf], nowMs: now });
        expect(plan.series).toEqual([{ symbol, timeframe: tf, bucketsChecked: 4, incomplete: 1, unchanged: 1, changed: 1, volumeOnly: 0, missing: 1 }]);
        expect(plan.changes.map((c) => [c.ts, c.kind])).toEqual([
            [new Date(b(0)).toISOString(), "ohlc"],
            [new Date(b(2)).toISOString(), "insert"],
        ]);
        expect(await row(0)).toEqual({ open: 1, high: 2, low: 0.5, close: 1.5, volume: 4 });
        expect(await row(2)).toBeNull();
    });

    it("commit fixes the frozen row, inserts the missing one, leaves incomplete/settling/current alone; idempotent", async () => {
        const plan = await planReroll({ pool, symbols: [symbol], timeframes: [tf], nowMs: now });
        expect(await applyReroll(pool, plan.changes)).toBe(2);

        expect(await row(0)).toEqual(expected(0));
        expect(await row(1)).toEqual(expected(1));
        expect(await row(2)).toEqual(expected(2));
        expect(await row(3)).toEqual({ open: 1, high: 2, low: 0.5, close: 1.5, volume: 4 });
        expect(await row(4)).toEqual({ open: 1, high: 2, low: 0.5, close: 1.5, volume: 4 });
        expect(await row(5)).toBeNull();

        const again = await planReroll({ pool, symbols: [symbol], timeframes: [tf], nowMs: now });
        expect(again.changes).toEqual([]);
    });

    it("volume-only differences are counted separately and skipped with ohlcOnly", async () => {
        await pool.query(
            `UPDATE candles SET volume = volume + 0.5 WHERE pair_id = $1 AND timeframe = $2 AND ts = to_timestamp($3 / 1000.0)`,
            [fx.pairId, tf, b(1)],
        );
        const all = await planReroll({ pool, symbols: [symbol], timeframes: [tf], nowMs: now });
        expect(all.series[0]).toMatchObject({ changed: 1, volumeOnly: 1, missing: 1, unchanged: 0 });
        expect(all.changes.find((c) => c.ts === new Date(b(1)).toISOString())?.kind).toBe("volume");

        const ohlcOnly = await planReroll({ pool, symbols: [symbol], timeframes: [tf], nowMs: now, ohlcOnly: true });
        expect(ohlcOnly.series[0]).toMatchObject({ changed: 1, volumeOnly: 1, missing: 1 });
        expect(ohlcOnly.changes.map((c) => c.kind)).toEqual(["ohlc", "insert"]);
    });

    it("revert restores old rows and deletes inserted ones — but never a row changed since", async () => {
        const plan = await planReroll({ pool, symbols: [symbol], timeframes: [tf], nowMs: now });
        await applyReroll(pool, plan.changes);
        expect(await revertReroll(pool, plan.changes)).toEqual({ restored: 1, deleted: 1, skipped: 0 });
        expect(await row(0)).toEqual({ open: 1, high: 2, low: 0.5, close: 1.5, volume: 4 });
        expect(await row(2)).toBeNull();

        await applyReroll(pool, plan.changes);
        await pool.query(`UPDATE candles SET close = 12345 WHERE pair_id = $1 AND timeframe = $2 AND ts = to_timestamp($3 / 1000.0)`, [fx.pairId, tf, b(0)]);
        expect(await revertReroll(pool, plan.changes)).toEqual({ restored: 0, deleted: 1, skipped: 1 });
        expect((await row(0))!.close).toBe(12345);
    });
});

describe("planReroll input checks", () => {
    it("rejects an unknown timeframe or symbol", async () => {
        await expect(planReroll({ pool, symbols: ["BTC/USD"], timeframes: ["2h"] })).rejects.toThrow(/Unknown timeframe/);
        await expect(planReroll({ pool, symbols: ["NOPE/USD"] })).rejects.toThrow(/No trading_pairs row/);
    });
});
