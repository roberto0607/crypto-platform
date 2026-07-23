/**
 * candleBackfill.test.ts — runBackfill()'s recency-skip behavior.
 *
 * Gate 2 step 5: CANDLE_BACKFILL_ON_BOOT should only backfill (pair,
 * timeframe) combinations that are actually missing recent data, not
 * unconditionally re-walk 7 days of history for the full curated universe
 * (~75 pairs × 5 timeframes) on every boot. loadActiveSymbols('coinbase')
 * only returns pairs with an active exchange_symbol_map row — the
 * migration-seeded BTC/ETH/SOL trading_pairs rows have none, so a fresh
 * test DB's only coinbase-mapped pair is the fixture created below.
 *
 * Integration test — hits the real Postgres at DATABASE_URL, global.fetch
 * stubbed so Coinbase REST calls are deterministic and don't hit the network.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { pool } from "../../db/pool";
import { runBackfill } from "../candleBackfill";

describe("runBackfill recency skip", () => {
    let uid: string;
    let pairId: string;
    let baseAssetId: string;
    let quoteAssetId: string;
    let originalFetch: typeof fetch;
    let fetchCallCount: number;

    beforeEach(async () => {
        uid = Math.random().toString(36).slice(2, 8);

        const { rows: baseRows } = await pool.query<{ id: string }>(
            `INSERT INTO assets (symbol, name, decimals) VALUES ($1, $2, 8) RETURNING id`,
            [`CB${uid.toUpperCase()}`, `fixture ${uid}`],
        );
        baseAssetId = baseRows[0]!.id;

        const { rows: quoteRows } = await pool.query<{ id: string }>(
            `INSERT INTO assets (symbol, name, decimals) VALUES ($1, $2, 2) RETURNING id`,
            [`CBQ${uid.toUpperCase()}`, `USD fixture ${uid}`],
        );
        quoteAssetId = quoteRows[0]!.id;

        const { rows: pairRows } = await pool.query<{ id: string }>(
            `INSERT INTO trading_pairs (base_asset_id, quote_asset_id, symbol, is_active)
             VALUES ($1, $2, $3, true) RETURNING id`,
            [baseAssetId, quoteAssetId, `CB${uid.toUpperCase()}/USD`],
        );
        pairId = pairRows[0]!.id;

        await pool.query(
            `INSERT INTO exchange_symbol_map (pair_id, exchange, ws_symbol, rest_symbol, is_active)
             VALUES ($1, 'coinbase', $2, $2, true)`,
            [pairId, `CB${uid.toUpperCase()}-USD`],
        );

        fetchCallCount = 0;
        originalFetch = global.fetch;
        global.fetch = (async (url: string | URL | Request) => {
            fetchCallCount++;
            const href = url.toString();
            if (href.includes("coinbase.com")) {
                return new Response(JSON.stringify({ candles: [] }), { status: 200 });
            }
            throw new Error(`unexpected fetch URL in test: ${href}`);
        }) as typeof fetch;
    });

    afterEach(async () => {
        global.fetch = originalFetch;
        await pool.query(`DELETE FROM candles WHERE pair_id = $1`, [pairId]);
        await pool.query(`DELETE FROM trading_pairs WHERE id = $1`, [pairId]);
        await pool.query(`DELETE FROM assets WHERE id = ANY($1)`, [[baseAssetId, quoteAssetId]]);
    });

    it("skips a timeframe with a recent candle and fetches ones that are missing/stale", async () => {
        // Fresh 1m candle (now) → should be skipped.
        await pool.query(
            `INSERT INTO candles (pair_id, timeframe, ts, open, high, low, close, volume)
             VALUES ($1, '1m', now(), 100, 100, 100, 100, 1)`,
            [pairId],
        );
        // Stale 1h candle (10 days old) → should NOT be skipped.
        await pool.query(
            `INSERT INTO candles (pair_id, timeframe, ts, open, high, low, close, volume)
             VALUES ($1, '1h', now() - interval '10 days', 100, 100, 100, 100, 1)`,
            [pairId],
        );
        // 5m/15m/1d/4h have no rows at all → should NOT be skipped.

        const result = await runBackfill();

        // Only 1m is skipped (fresh candle); 5m/15m/1h/1d are missing/stale
        // and get fetched (backfillPairTimeframe paginates internally, so
        // the exact REST call count varies with candle density over the
        // 7-day lookback — just assert fetches happened at all). The 4h
        // rollup is a local SQL aggregation with no REST call either way.
        expect(result.totalSkipped).toBe(1);
        expect(fetchCallCount).toBeGreaterThan(0);
        expect(result.totalErrors).toBe(0);
    });

    it("skips every timeframe (including the 4h and 1w rollups) once all are recent", async () => {
        for (const tf of ["1m", "5m", "15m", "1h", "1d", "4h", "1w"]) {
            await pool.query(
                `INSERT INTO candles (pair_id, timeframe, ts, open, high, low, close, volume)
                 VALUES ($1, $2, now(), 100, 100, 100, 100, 1)`,
                [pairId, tf],
            );
        }

        const result = await runBackfill();

        expect(result.totalSkipped).toBe(7); // 5 fetch timeframes + the 4h rollup check + the 1w rollup check
        expect(fetchCallCount).toBe(0);
        expect(result.totalErrors).toBe(0);
    });
});
