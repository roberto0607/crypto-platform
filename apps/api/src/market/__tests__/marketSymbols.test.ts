/**
 * marketSymbols.test.ts — MARKET_SYMBOLS storage allowlist.
 *
 * Pure parsing/filtering, plus the write paths that persist candle history
 * (1m flush, rollup job, boot backfill) against the real test DB: an
 * allowlisted fixture pair gets rows, a non-allowlisted one gets none.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { pool } from "../../db/pool";
import { parseMarketSymbols, normalizeMarketSymbol, DEFAULT_MARKET_SYMBOLS } from "../../config";
import {
    isMarketDataSymbol,
    filterMarketDataPairs,
    getMarketDataPairIds,
    resetMarketDataPairIdCache,
} from "../marketSymbols";
import { aggregateTick, flushDueCandles } from "../candleAggregator";
import { runBackfill } from "../candleBackfill";

describe("parseMarketSymbols", () => {
    it("defaults to BTC-USD, ETH-USD, SOL-USD when unset or blank", () => {
        const expected = new Set(["BTC/USD", "ETH/USD", "SOL/USD"]);
        expect(parseMarketSymbols(undefined)).toEqual(expected);
        expect(parseMarketSymbols("")).toEqual(expected);
        expect(parseMarketSymbols(" , ")).toEqual(expected);
        expect(DEFAULT_MARKET_SYMBOLS).toEqual(["BTC-USD", "ETH-USD", "SOL-USD"]);
    });

    it("normalizes dash/slash/case/whitespace to trading_pairs.symbol form", () => {
        expect(parseMarketSymbols(" btc-usd ,ETH/USD")).toEqual(new Set(["BTC/USD", "ETH/USD"]));
        expect(normalizeMarketSymbol("sol-usd")).toBe("SOL/USD");
    });

    it("rejects malformed entries at parse time", () => {
        expect(() => parseMarketSymbols("BTCUSD")).toThrow(/Invalid market symbol/);
        expect(() => parseMarketSymbols("BTC-USD,ETH-")).toThrow(/Invalid market symbol/);
        expect(() => parseMarketSymbols("BTC-USD-PERP")).toThrow(/Invalid market symbol/);
    });
});

describe("isMarketDataSymbol / filterMarketDataPairs", () => {
    const allow = parseMarketSymbols("BTC-USD,ETH-USD");

    it("matches either symbol spelling and nothing else", () => {
        expect(isMarketDataSymbol("BTC/USD", allow)).toBe(true);
        expect(isMarketDataSymbol("eth-usd", allow)).toBe(true);
        expect(isMarketDataSymbol("SOL/USD", allow)).toBe(false);
        expect(isMarketDataSymbol("garbage", allow)).toBe(false);
    });

    it("filters a pair list", () => {
        const pairs = [{ symbol: "BTC/USD" }, { symbol: "DOGE/USD" }, { symbol: "ETH/USD" }];
        expect(filterMarketDataPairs(pairs, (p) => p.symbol, allow).map((p) => p.symbol))
            .toEqual(["BTC/USD", "ETH/USD"]);
    });

    it("default config allowlist is the three majors", () => {
        expect(isMarketDataSymbol("BTC/USD")).toBe(true);
        expect(isMarketDataSymbol("ETH/USD")).toBe(true);
        expect(isMarketDataSymbol("SOL/USD")).toBe(true);
        expect(isMarketDataSymbol("DOGE/USD")).toBe(false);
    });
});

describe("candle write paths honor the allowlist (DB)", () => {
    let uid: string;
    const created: { assets: string[]; pairs: string[] } = { assets: [], pairs: [] };

    async function makePair(symbol: string): Promise<string> {
        const base = symbol.split("/")[0]!;
        const { rows: a } = await pool.query<{ id: string }>(
            `INSERT INTO assets (symbol, name, decimals) VALUES ($1, $1, 8) RETURNING id`,
            [base],
        );
        const { rows: q } = await pool.query<{ id: string }>(
            `INSERT INTO assets (symbol, name, decimals) VALUES ($1, $1, 2) RETURNING id`,
            [`Q${base}`],
        );
        created.assets.push(a[0]!.id, q[0]!.id);
        const { rows: p } = await pool.query<{ id: string }>(
            `INSERT INTO trading_pairs (base_asset_id, quote_asset_id, symbol, is_active)
             VALUES ($1, $2, $3, true) RETURNING id`,
            [a[0]!.id, q[0]!.id, symbol],
        );
        created.pairs.push(p[0]!.id);
        await pool.query(
            `INSERT INTO exchange_symbol_map (pair_id, exchange, ws_symbol, rest_symbol, is_active)
             VALUES ($1, 'coinbase', $2, $2, true)`,
            [p[0]!.id, symbol.replace("/", "-")],
        );
        return p[0]!.id;
    }

    async function candleCount(pairId: string, tf?: string): Promise<number> {
        const { rows } = await pool.query<{ n: string }>(
            `SELECT count(*) AS n FROM candles WHERE pair_id = $1 AND ($2::text IS NULL OR timeframe = $2)`,
            [pairId, tf ?? null],
        );
        return Number(rows[0]!.n);
    }

    beforeEach(() => {
        uid = Math.random().toString(36).slice(2, 7).toUpperCase();
        resetMarketDataPairIdCache();
    });

    afterEach(async () => {
        await pool.query(`DELETE FROM candles WHERE pair_id = ANY($1)`, [created.pairs]);
        await pool.query(`DELETE FROM exchange_symbol_map WHERE pair_id = ANY($1)`, [created.pairs]);
        await pool.query(`DELETE FROM trading_pairs WHERE id = ANY($1)`, [created.pairs]);
        await pool.query(`DELETE FROM assets WHERE id = ANY($1)`, [created.assets]);
        created.assets = [];
        created.pairs = [];
        resetMarketDataPairIdCache();
    });

    it("getMarketDataPairIds resolves only allowlisted symbols", async () => {
        const inId = await makePair(`IN${uid}/USD`);
        const outId = await makePair(`OUT${uid}/USD`);
        const ids = await getMarketDataPairIds(new Set([`IN${uid}/USD`]));
        expect(ids.has(inId)).toBe(true);
        expect(ids.has(outId)).toBe(false);
    });

    it("1m flush writes only the allowlisted pair", async () => {
        // The default allowlist (BTC/ETH/SOL) is what flushDueCandles uses,
        // so the "in" pair here is the migration-seeded BTC/USD.
        const { rows } = await pool.query<{ id: string }>(
            `SELECT id FROM trading_pairs WHERE symbol = 'BTC/USD'`,
        );
        const btcId = rows[0]!.id;
        const outId = await makePair(`OUT${uid}/USD`);

        // A minute that is fully in the past so it flushes immediately.
        const ts = Math.floor(Date.now() / 60_000) * 60_000 - 10 * 60_000;
        aggregateTick(btcId, { price: "50000", volume: "1", ts });
        aggregateTick(outId, { price: "1", volume: "1", ts });
        await flushDueCandles();

        const { rows: btc } = await pool.query(
            `SELECT 1 FROM candles WHERE pair_id = $1 AND timeframe = '1m' AND ts = to_timestamp($2 / 1000.0)`,
            [btcId, ts],
        );
        expect(btc).toHaveLength(1);
        expect(await candleCount(outId)).toBe(0);
        await pool.query(
            `DELETE FROM candles WHERE pair_id = $1 AND timeframe = '1m' AND ts = to_timestamp($2 / 1000.0)`,
            [btcId, ts],
        );
    });

    it("boot backfill never fetches or writes a non-allowlisted pair", async () => {
        const outId = await makePair(`OUT${uid}/USD`);
        const originalFetch = global.fetch;
        const fetched: string[] = [];
        global.fetch = (async (url: string | URL | Request) => {
            fetched.push(url.toString());
            return new Response(JSON.stringify({
                candles: [{ start: "1700000000", open: "1", high: "1", low: "1", close: "1", volume: "1" }],
            }), { status: 200 });
        }) as typeof fetch;
        try {
            const result = await runBackfill({ marketSymbols: new Set(["NOPE/USD"]) });
            expect(result.totalInserted).toBe(0);
            expect(fetched.filter((u) => u.includes(`OUT${uid}`))).toHaveLength(0);
            expect(await candleCount(outId)).toBe(0);
        } finally {
            global.fetch = originalFetch;
        }
    });

    it("rollup job skips non-allowlisted pairs even when they have 1m candles", async () => {
        const { candleRollupJob } = await import("../../jobs/definitions/candleRollupJob");
        const outId = await makePair(`OUT${uid}/USD`);
        const start = Math.floor(Date.now() / 3_600_000) * 3_600_000 - 2 * 3_600_000;
        for (let i = 0; i < 10; i++) {
            await pool.query(
                `INSERT INTO candles (pair_id, timeframe, ts, open, high, low, close, volume)
                 VALUES ($1, '1m', to_timestamp($2 / 1000.0), 1, 1, 1, 1, 1)`,
                [outId, start + i * 60_000],
            );
        }
        await candleRollupJob.run({} as never);
        expect(await candleCount(outId, "5m")).toBe(0);
        expect(await candleCount(outId, "1m")).toBe(10);
    });
});
