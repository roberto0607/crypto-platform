/**
 * symbolSync.test.ts — checkDelistings() integration test.
 *
 * discoverSyncCandidates()/applyCandidates() are exercised end-to-end (real
 * Kraken/Coinbase APIs) by the backfillExchangeSymbols.ts dry-run/--commit
 * runs documented in the Gate 2 implementation — this test focuses on
 * checkDelistings()'s DB-mutation logic, which needs deterministic exchange
 * responses to test both "delisted on one exchange" (mapping row goes
 * inactive, pair stays tradeable via the other exchange) and "delisted on
 * both" (pair itself goes inactive). global.fetch is stubbed so the test
 * doesn't depend on live exchange listings changing.
 *
 * Integration test — hits the real Postgres at DATABASE_URL, mirroring the
 * fixture pattern of matchCleanupJob.test.ts (direct pool.query setup with
 * randomized-per-run symbols to avoid colliding with seeded/real data).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { pool } from "../../db/pool";
import { checkDelistings } from "../symbolSync";

async function createFixturePair(uid: string, baseSymbol: string, quoteAssetId: string) {
    const { rows: baseRows } = await pool.query<{ id: string }>(
        `INSERT INTO assets (symbol, name, decimals) VALUES ($1, $2, 8) RETURNING id`,
        [baseSymbol, `${baseSymbol} fixture`],
    );
    const baseAssetId = baseRows[0]!.id;

    const { rows: pairRows } = await pool.query<{ id: string }>(
        `INSERT INTO trading_pairs (base_asset_id, quote_asset_id, symbol, is_active)
         VALUES ($1, $2, $3, true) RETURNING id`,
        [baseAssetId, quoteAssetId, `${baseSymbol}/USD-${uid}`],
    );
    const pairId = pairRows[0]!.id;

    await pool.query(
        `INSERT INTO exchange_symbol_map (pair_id, exchange, ws_symbol, rest_symbol, is_active)
         VALUES ($1, 'kraken', $2, $2, true), ($1, 'coinbase', $3, $3, true)`,
        [pairId, `${baseSymbol}/USD`, `${baseSymbol}-USD`],
    );

    return { pairId, baseAssetId, baseSymbol };
}

describe("checkDelistings", () => {
    let uid: string;
    let quoteAssetId: string;
    let originalFetch: typeof fetch;
    const createdPairIds: string[] = [];
    const createdAssetIds: string[] = [];

    beforeEach(async () => {
        uid = Math.random().toString(36).slice(2, 8);
        const { rows } = await pool.query<{ id: string }>(
            `INSERT INTO assets (symbol, name, decimals) VALUES ($1, $2, 2) RETURNING id`,
            [`SDQ${uid.toUpperCase()}`, `USD fixture ${uid}`],
        );
        quoteAssetId = rows[0]!.id;
        createdAssetIds.push(quoteAssetId);
        originalFetch = global.fetch;
    });

    afterEach(async () => {
        global.fetch = originalFetch;
        // Every test's fixture pairs are visible to checkDelistings' unscoped
        // "all active exchange_symbol_map rows" query, so leftover fixtures
        // from one test would otherwise get swept up (and deactivated) by
        // the next test's mocked exchange responses. Clean up after every
        // test, not just at the end of the suite.
        if (createdPairIds.length > 0) {
            await pool.query(`DELETE FROM trading_pairs WHERE id = ANY($1)`, [createdPairIds]);
            createdPairIds.length = 0;
        }
        if (createdAssetIds.length > 0) {
            await pool.query(`DELETE FROM assets WHERE id = ANY($1)`, [createdAssetIds]);
            createdAssetIds.length = 0;
        }
    });

    function mockExchangeResponses(krakenOnlineBases: string[], coinbaseOnlineBases: string[]) {
        global.fetch = (async (url: string | URL | Request) => {
            const href = url.toString();
            if (href.includes("kraken.com")) {
                const result: Record<string, unknown> = {};
                for (const base of krakenOnlineBases) {
                    result[`${base}USD`] = {
                        wsname: `${base}/USD`,
                        altname: `${base}USD`,
                        base,
                        quote: "ZUSD",
                        status: "online",
                    };
                }
                return new Response(JSON.stringify({ error: [], result }), { status: 200 });
            }
            if (href.includes("coinbase.com")) {
                const products = coinbaseOnlineBases.map((base) => ({
                    product_id: `${base}-USD`,
                    base_currency_id: base,
                    quote_currency_id: "USD",
                    base_name: base,
                    trading_disabled: false,
                    status: "online",
                    approximate_quote_24h_volume: "1000",
                }));
                return new Response(JSON.stringify({ products }), { status: 200 });
            }
            throw new Error(`unexpected fetch URL in test: ${href}`);
        }) as typeof fetch;
    }

    it("leaves both exchange rows active when the pair is still listed on both", async () => {
        const stillListed = await createFixturePair(uid, `TA${uid.toUpperCase()}`, quoteAssetId);
        createdPairIds.push(stillListed.pairId);
        createdAssetIds.push(stillListed.baseAssetId);
        mockExchangeResponses([stillListed.baseSymbol], [stillListed.baseSymbol]);

        const client = await pool.connect();
        try {
            const result = await checkDelistings(client);
            expect(result.exchangeRowsDeactivated).toBe(0);
            expect(result.pairsDeactivated).toBe(0);
        } finally {
            client.release();
        }

        const { rows } = await pool.query<{ is_active: boolean }>(
            `SELECT is_active FROM trading_pairs WHERE id = $1`,
            [stillListed.pairId],
        );
        expect(rows[0]!.is_active).toBe(true);
    });

    it("deactivates only the delisted exchange's row when the pair is still live on the other", async () => {
        const delistedFromKraken = await createFixturePair(uid, `TB${uid.toUpperCase()}`, quoteAssetId);
        createdPairIds.push(delistedFromKraken.pairId);
        createdAssetIds.push(delistedFromKraken.baseAssetId);
        // Missing from the Kraken mock, still present on Coinbase.
        mockExchangeResponses([], [delistedFromKraken.baseSymbol]);

        const client = await pool.connect();
        try {
            const result = await checkDelistings(client);
            expect(result.exchangeRowsDeactivated).toBe(1);
            expect(result.pairsDeactivated).toBe(0);
        } finally {
            client.release();
        }

        const { rows } = await pool.query<{ exchange: string; is_active: boolean }>(
            `SELECT exchange, is_active FROM exchange_symbol_map WHERE pair_id = $1 ORDER BY exchange`,
            [delistedFromKraken.pairId],
        );
        expect(rows).toEqual([
            { exchange: "coinbase", is_active: true },
            { exchange: "kraken", is_active: false },
        ]);

        const { rows: pairRows } = await pool.query<{ is_active: boolean }>(
            `SELECT is_active FROM trading_pairs WHERE id = $1`,
            [delistedFromKraken.pairId],
        );
        expect(pairRows[0]!.is_active).toBe(true);
    });

    it("deactivates the trading_pairs row once BOTH exchanges have delisted it", async () => {
        const delistedFromBoth = await createFixturePair(uid, `TC${uid.toUpperCase()}`, quoteAssetId);
        createdPairIds.push(delistedFromBoth.pairId);
        createdAssetIds.push(delistedFromBoth.baseAssetId);
        mockExchangeResponses([], []);

        const client = await pool.connect();
        try {
            const result = await checkDelistings(client);
            expect(result.exchangeRowsDeactivated).toBe(2);
            expect(result.pairsDeactivated).toBe(1);
        } finally {
            client.release();
        }

        const { rows: pairRows } = await pool.query<{ is_active: boolean }>(
            `SELECT is_active FROM trading_pairs WHERE id = $1`,
            [delistedFromBoth.pairId],
        );
        expect(pairRows[0]!.is_active).toBe(false);
    });
});
