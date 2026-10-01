/**
 * historyBackfill.test.ts — idempotency, resume, rollups, retry and throttle
 * for the post-recovery history backfill, against the real test DB with a
 * deterministic fake Coinbase.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { pool } from "../../db/pool";
import { runHistoryBackfill, type TimeframeWindow } from "../historyBackfill";

const DAY = 86_400;
const GRAN_SEC: Record<string, number> = {
    ONE_MINUTE: 60, FIVE_MINUTE: 300, FIFTEEN_MINUTE: 900, ONE_HOUR: 3600, ONE_DAY: 86_400,
};

// now aligned to a Wednesday 12:00 UTC so 1w/4h buckets are deterministic
const NOW = Date.UTC(2026, 8, 30, 12, 0, 0) / 1000;
const LISTING = Math.floor((NOW - 15 * DAY) / DAY) * DAY; // listed at 00:00 UTC, 15 days ago

/** Fake Coinbase: one candle per granularity step in [start, end], from LISTING on. */
function fakeCoinbase(calls: string[], opts: { failFirstWith?: number } = {}): typeof fetch {
    let failed = false;
    return (async (input: string | URL | Request) => {
        const url = new URL(input.toString());
        calls.push(url.toString());
        if (opts.failFirstWith && !failed) {
            failed = true;
            return new Response("slow down", { status: opts.failFirstWith, headers: { "retry-after": "1" } });
        }
        const g = url.searchParams.get("granularity")!;
        const step = GRAN_SEC[g]!;
        const start = Number(url.searchParams.get("start"));
        const end = Number(url.searchParams.get("end"));
        const candles = [];
        for (let t = Math.ceil(start / step) * step; t <= end; t += step) {
            if (t < LISTING) continue;
            const p = 100 + ((t / step) % 17);
            candles.push({ start: String(t), open: String(p), high: String(p + 2), low: String(p - 1), close: String(p + 1), volume: "3" });
        }
        return new Response(JSON.stringify({ candles: candles.reverse() }), { status: 200 });
    }) as typeof fetch;
}

const PLAN: TimeframeWindow[] = [
    { tf: "1d", granularity: "ONE_DAY", candleSeconds: DAY, days: null },
    { tf: "1h", granularity: "ONE_HOUR", candleSeconds: 3600, days: null },
    { tf: "5m", granularity: "FIVE_MINUTE", candleSeconds: 300, days: 2 },
];

describe("runHistoryBackfill", () => {
    let uid: string;
    let symbol: string;
    let pairId: string;
    let assetIds: string[];
    const noSleep = async () => {};

    async function snapshot(): Promise<string> {
        const { rows } = await pool.query(
            `SELECT timeframe, extract(epoch FROM ts)::bigint AS t, open::text, high::text, low::text, close::text, volume::text
             FROM candles WHERE pair_id = $1 ORDER BY timeframe, ts`,
            [pairId],
        );
        return JSON.stringify(rows);
    }

    async function counts(): Promise<Record<string, number>> {
        const { rows } = await pool.query<{ timeframe: string; n: string }>(
            `SELECT timeframe, count(*) n FROM candles WHERE pair_id = $1 GROUP BY 1`,
            [pairId],
        );
        return Object.fromEntries(rows.map((r) => [r.timeframe, Number(r.n)]));
    }

    function run(calls: string[], extra: Partial<Parameters<typeof runHistoryBackfill>[0]> = {}) {
        return runHistoryBackfill({
            pool,
            symbols: [symbol],
            plan: PLAN,
            nowSec: NOW,
            fullHistoryStartSec: NOW - 40 * DAY,
            minIntervalMs: 0,
            sleep: noSleep,
            fetchImpl: fakeCoinbase(calls),
            ...extra,
        });
    }

    beforeEach(async () => {
        uid = Math.random().toString(36).slice(2, 7).toUpperCase();
        symbol = `HB${uid}/USD`;
        const { rows: a } = await pool.query<{ id: string }>(
            `INSERT INTO assets (symbol, name, decimals) VALUES ($1, $1, 8), ($2, $2, 2) RETURNING id`,
            [`HB${uid}`, `HQ${uid}`],
        );
        assetIds = a.map((r) => r.id);
        const { rows: p } = await pool.query<{ id: string }>(
            `INSERT INTO trading_pairs (base_asset_id, quote_asset_id, symbol, is_active)
             VALUES ($1, $2, $3, false) RETURNING id`,
            [assetIds[0], assetIds[1], symbol],
        );
        pairId = p[0]!.id;
    });

    afterEach(async () => {
        await pool.query(`DELETE FROM candles WHERE pair_id = $1`, [pairId]);
        await pool.query(`DELETE FROM trading_pairs WHERE id = $1`, [pairId]);
        await pool.query(`DELETE FROM assets WHERE id = ANY($1)`, [assetIds]);
    });

    it("downloads each window, starting full-history series at the listing date", async () => {
        const calls: string[] = [];
        await run(calls);
        const c = await counts();
        expect(c["1d"]).toBe(15);              // listing → yesterday (today is in progress)
        expect(c["1h"]).toBe(15 * 24 + 12);     // listing → current hour
        expect(c["5m"]).toBe(2 * 288);          // 2-day window
        expect(c["4h"]).toBeGreaterThan(0);
        expect(c["1w"]).toBeGreaterThan(0);

        const { rows } = await pool.query<{ t: string }>(
            `SELECT extract(epoch FROM min(ts))::bigint t FROM candles WHERE pair_id = $1 AND timeframe = '1h'`,
            [pairId],
        );
        expect(Number(rows[0]!.t)).toBe(LISTING);
        // 1h walk started at the listing (from 1d), not at the 40-day lower bound
        expect(calls.filter((u) => u.includes("ONE_HOUR") && Number(new URL(u).searchParams.get("start")) < LISTING)).toHaveLength(0);
    });

    it("is idempotent: a re-run leaves identical rows and only fetches the tail", async () => {
        const first: string[] = [];
        await run(first);
        const before = await snapshot();
        const countsBefore = await counts();

        const second: string[] = [];
        const res = await run(second);
        expect(await snapshot()).toBe(before);
        expect(await counts()).toEqual(countsBefore);
        // 1d always re-walks (its window start *is* the unknown listing date;
        // ~12 requests for a decade), everything else resumes from its tail.
        expect(res.series.filter((s) => s.tf !== "1d").every((s) => s.resumed)).toBe(true);
        expect(second.length).toBeLessThan(first.length);
    });

    it("force refetches everything and still leaves identical rows", async () => {
        await run([]);
        const before = await snapshot();
        const forced: string[] = [];
        const res = await run(forced, { force: true });
        expect(res.series.some((s) => s.resumed)).toBe(false);
        expect(forced.length).toBeGreaterThan(0);
        expect(await snapshot()).toBe(before);
    });

    it("resumes after an interrupted run without duplicating", async () => {
        // Simulate a crash mid-way: complete run, then drop the newest 1h half.
        await run([]);
        const full = await snapshot();
        await pool.query(
            `DELETE FROM candles WHERE pair_id = $1 AND timeframe = '1h' AND ts > to_timestamp($2)`,
            [pairId, NOW - 7 * DAY],
        );
        await run([]);
        expect(await snapshot()).toBe(full);
    });

    it("dry run writes nothing", async () => {
        const res = await run([], { dryRun: true });
        expect(res.requests).toBeGreaterThan(0);
        expect(await counts()).toEqual({});
    });

    it("retries 429 honoring Retry-After", async () => {
        const slept: number[] = [];
        const calls: string[] = [];
        await run(calls, {
            plan: [PLAN[0]!],
            fetchImpl: fakeCoinbase(calls, { failFirstWith: 429 }),
            sleep: async (ms) => { slept.push(ms); },
        });
        expect(slept).toContain(1000);
        expect((await counts())["1d"]).toBe(15);
    });

    it("throttles requests to minIntervalMs", async () => {
        const slept: number[] = [];
        await run([], {
            plan: [PLAN[2]!],
            minIntervalMs: 250,
            sleep: async (ms) => { slept.push(ms); },
        });
        // 2 days of 5m = 576 candles = 2 pages → the second waits on the throttle
        expect(slept.length).toBeGreaterThanOrEqual(1);
        expect(Math.max(...slept)).toBeLessThanOrEqual(250);
    });

    it("refuses symbols with no trading_pairs row", async () => {
        await expect(run([], { symbols: ["NOPE/USD"] })).rejects.toThrow(/No trading_pairs row for NOPE\/USD/);
    });
});
