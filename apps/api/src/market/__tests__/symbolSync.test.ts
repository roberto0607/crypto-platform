/**
 * symbolSync.test.ts — coverage for symbolSync.ts.
 *
 * Two kinds of test live here, matching how the module itself splits:
 *
 *   NETWORK-MOCKED, NO DB (fetchTopMarketCapSymbols, discoverSyncCandidates):
 *     global.fetch is stubbed per-test for the Kraken / Coinbase / CoinGecko
 *     REST calls. discoverSyncCandidates also opens a Kraken WebSocket via
 *     verifyKrakenWsSymbols(), so the `ws` module is mocked (see vi.mock("ws")
 *     below) — a fabricated test symbol would be rejected by the real
 *     wss://ws.kraken.com/v2, making the ranking logic unobservable otherwise.
 *
 *   REAL POSTGRES (checkDelistings, upsertCandidate, prunePairs,
 *   deactivatePairsGuarded): hits the dedicated *_test database at
 *   DATABASE_URL, mirroring matchCleanupJob.test.ts — direct pool.query
 *   fixture setup with randomized-per-run symbols so leftover rows from
 *   other test files never collide, and explicit per-test cleanup.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { pool } from "../../db/pool";
import {
    checkDelistings,
    upsertCandidate,
    fetchTopMarketCapSymbols,
    discoverSyncCandidates,
    prunePairs,
    deactivatePairsGuarded,
    MCAP_PRUNE_GRACE_RUNS,
    type SyncCandidate,
} from "../symbolSync";

// Group (d) asserts deactivatePairsGuarded() logs
// pair_deactivation_safety_assertion_failed. symbolSync.ts uses
// rootLogger.child({ module }), so the child's `.error` must be the SAME
// fn the test sees — a hoisted shared vi.fn() threaded through the
// canonical makeMockLogger shape does that (child() still returns a fresh
// logger for info/warn/debug, which no test cares about).
const { mockLoggerError } = vi.hoisted(() => ({ mockLoggerError: vi.fn() }));

vi.mock("../../observability/logContext", () => {
    const makeMockLogger = (): Record<string, unknown> => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: mockLoggerError,
        debug: vi.fn(),
        child: vi.fn(() => makeMockLogger()),
    });
    return { buildLogContext: vi.fn(() => ({})), logger: makeMockLogger() };
});

// Minimal fake of the `ws` default export — just enough for
// verifyKrakenWsSymbols(): emit `open` once (deferred past the synchronous
// .on() registrations), then on the subscribe `send()` echo one Kraken-v2
// success frame per requested symbol, so every fabricated symbol
// "verifies". No network, fully synchronous.
vi.mock("ws", () => {
    class FakeWebSocket {
        private handlers: Record<string, ((arg?: unknown) => void)[]> = {};
        constructor(_url: string) {
            queueMicrotask(() => this.emit("open"));
        }
        on(event: string, cb: (arg?: unknown) => void) {
            (this.handlers[event] ??= []).push(cb);
            return this;
        }
        send(payload: string) {
            const msg = JSON.parse(payload) as { params?: { symbol?: string[] } };
            for (const symbol of msg.params?.symbol ?? []) {
                this.emit(
                    "message",
                    Buffer.from(JSON.stringify({ method: "subscribe", success: true, result: { symbol } })),
                );
            }
        }
        terminate() { /* no-op */ }
        private emit(event: string, arg?: unknown) {
            for (const cb of this.handlers[event] ?? []) cb(arg);
        }
    }
    return { default: FakeWebSocket };
});

// ──────────────────────────────────────────────────────────────────────
// Shared fetch mock for the network-mocked groups (a) + (b). ONE helper,
// one URL-dispatch shape. (checkDelistings' own mockExchangeResponses
// below is a deliberate DB-coupled specialization — it merges live-DB
// "background" symbols so its unscoped query doesn't sweep leftover
// fixtures — not a parallel version of this.)
// ──────────────────────────────────────────────────────────────────────

function mcapRow(symbol: string, rank: number | null) {
    return { id: symbol.toLowerCase(), symbol: symbol.toLowerCase(), name: symbol, market_cap_rank: rank };
}

interface UpstreamSymbol {
    symbol: string;          // UPPERCASE, e.g. "BTC"
    volumeUsd24h?: number;   // Coinbase approximate_quote_24h_volume, default 0
}

interface UpstreamOpts {
    coingecko?: { rows: unknown; status?: number };
    kraken?: { symbols: UpstreamSymbol[]; status?: number };
    coinbase?: { symbols: UpstreamSymbol[]; status?: number };
}

function mockUpstream(opts: UpstreamOpts) {
    global.fetch = (async (url: string | URL | Request) => {
        const href = url.toString();

        if (href.includes("coingecko.com")) {
            if (!opts.coingecko) throw new Error(`unexpected CoinGecko fetch in test: ${href}`);
            const { rows, status = 200 } = opts.coingecko;
            return new Response(typeof rows === "string" ? rows : JSON.stringify(rows), { status });
        }
        if (href.includes("kraken.com")) {
            if (!opts.kraken) throw new Error(`unexpected Kraken fetch in test: ${href}`);
            const { symbols, status = 200 } = opts.kraken;
            const result: Record<string, unknown> = {};
            for (const { symbol } of symbols) {
                result[`${symbol}USD`] = {
                    wsname: `${symbol}/USD`,
                    altname: `${symbol}USD`,
                    base: symbol,
                    quote: "ZUSD",
                    status: "online",
                };
            }
            return new Response(JSON.stringify({ error: [], result }), { status });
        }
        if (href.includes("coinbase.com")) {
            if (!opts.coinbase) throw new Error(`unexpected Coinbase fetch in test: ${href}`);
            const { symbols, status = 200 } = opts.coinbase;
            const products = symbols.map(({ symbol, volumeUsd24h = 0 }) => ({
                product_id: `${symbol}-USD`,
                base_currency_id: symbol,
                quote_currency_id: "USD",
                base_name: symbol,
                trading_disabled: false,
                status: "online",
                approximate_quote_24h_volume: String(volumeUsd24h),
            }));
            return new Response(JSON.stringify({ products }), { status });
        }
        throw new Error(`unexpected fetch URL in test: ${href}`);
    }) as typeof fetch;
}

// ──────────────────────────────────────────────────────────────────────
// Group (a): fetchTopMarketCapSymbols — network-mocked, no DB
// ──────────────────────────────────────────────────────────────────────

describe("fetchTopMarketCapSymbols", () => {
    let originalFetch: typeof fetch;

    beforeEach(() => {
        originalFetch = global.fetch;
    });
    afterEach(() => {
        global.fetch = originalFetch;
    });

    it("returns a Map of UPPERCASE symbol -> market_cap_rank on a successful fetch", async () => {
        mockUpstream({
            coingecko: {
                rows: [mcapRow("btc", 1), mcapRow("eth", 2), mcapRow("sol", 3), mcapRow("xrp", 4), mcapRow("bnb", 5)],
            },
        });

        const map = await fetchTopMarketCapSymbols(5);

        expect(map.size).toBe(5);
        expect(map.get("BTC")).toBe(1);
        expect(map.get("SOL")).toBe(3);
        expect(map.get("BNB")).toBe(5);
        expect(map.has("btc")).toBe(false); // keys are upper-cased
    });

    it("throws on a non-2xx response", async () => {
        mockUpstream({ coingecko: { rows: [mcapRow("btc", 1)], status: 500 } });
        await expect(fetchTopMarketCapSymbols(5)).rejects.toThrow(/HTTP 500/);
    });

    it("throws when the response body is not an array", async () => {
        mockUpstream({ coingecko: { rows: { status: "error", message: "rate limited" } } });
        await expect(fetchTopMarketCapSymbols(5)).rejects.toThrow(/non-array body/);
    });

    it("throws when fewer than topN rows are returned", async () => {
        mockUpstream({ coingecko: { rows: [mcapRow("btc", 1), mcapRow("eth", 2)] } });
        await expect(fetchTopMarketCapSymbols(5)).rejects.toThrow(/only 2 well-formed rows/);
    });

    it("throws when malformed rows drop the well-formed count below topN", async () => {
        mockUpstream({
            coingecko: {
                rows: [mcapRow("btc", 1), mcapRow("eth", null), { id: "x", name: "x" }, mcapRow("sol", 3), mcapRow("xrp", 4)],
            },
        });
        await expect(fetchTopMarketCapSymbols(5)).rejects.toThrow(/only 3 well-formed rows/);
    });

    it("keeps the lowest rank when two rows share a symbol, without tripping the truncation guard", async () => {
        mockUpstream({
            coingecko: {
                rows: [
                    mcapRow("btc", 1),
                    mcapRow("eth", 2),
                    mcapRow("sol", 3),
                    mcapRow("xrp", 4),
                    mcapRow("bnb", 5),
                    mcapRow("eth", 25), // duplicate ticker, worse rank
                ],
            },
        });

        const map = await fetchTopMarketCapSymbols(5);

        expect(map.size).toBe(5);
        expect(map.get("ETH")).toBe(2); // first (best) rank kept
    });
});

// ──────────────────────────────────────────────────────────────────────
// Group (b): discoverSyncCandidates — market-cap ranking. Network-mocked
// (fetch + ws), no DB.
// ──────────────────────────────────────────────────────────────────────

describe("discoverSyncCandidates — market-cap ranking", () => {
    let originalFetch: typeof fetch;

    beforeEach(() => {
        originalFetch = global.fetch;
    });
    afterEach(() => {
        global.fetch = originalFetch;
    });

    it("returns only symbols in Kraken ∩ Coinbase ∩ the top-N market-cap set", async () => {
        mockUpstream({
            // QUX is on BOTH exchanges but not top-3 by market cap.
            // FOO is Kraken-only; BAR is Coinbase-only.
            kraken: { symbols: [{ symbol: "BTC" }, { symbol: "ETH" }, { symbol: "SOL" }, { symbol: "QUX" }, { symbol: "FOO" }] },
            coinbase: { symbols: [{ symbol: "BTC" }, { symbol: "ETH" }, { symbol: "SOL" }, { symbol: "QUX" }, { symbol: "BAR" }] },
            coingecko: { rows: [mcapRow("btc", 1), mcapRow("eth", 2), mcapRow("sol", 3)] },
        });

        const candidates = await discoverSyncCandidates(3);

        expect(candidates.map((c) => c.baseSymbol)).toEqual(["BTC", "ETH", "SOL"]);
        expect(candidates.some((c) => c.baseSymbol === "QUX")).toBe(false);
        expect(candidates.some((c) => c.baseSymbol === "FOO" || c.baseSymbol === "BAR")).toBe(false);
    });

    it("orders results by market-cap rank ascending, not by 24h volume", async () => {
        mockUpstream({
            kraken: { symbols: [{ symbol: "AAA" }, { symbol: "BBB" }, { symbol: "CCC" }] },
            // volume-descending order would be AAA, CCC, BBB
            coinbase: {
                symbols: [
                    { symbol: "AAA", volumeUsd24h: 1_000_000 },
                    { symbol: "BBB", volumeUsd24h: 5 },
                    { symbol: "CCC", volumeUsd24h: 999 },
                ],
            },
            // market-cap-rank order is BBB, CCC, AAA — deliberately the reverse
            coingecko: { rows: [mcapRow("bbb", 1), mcapRow("ccc", 2), mcapRow("aaa", 3)] },
        });

        const candidates = await discoverSyncCandidates(3, new Set(["AAA/USD", "BBB/USD", "CCC/USD"]));

        expect(candidates.map((c) => c.baseSymbol)).toEqual(["BBB", "CCC", "AAA"]);
        // volumeUsd24h still populated on each candidate — just not the sort key.
        expect(candidates.find((c) => c.baseSymbol === "BBB")!.volumeUsd24h).toBe(5);
        expect(candidates.find((c) => c.baseSymbol === "AAA")!.volumeUsd24h).toBe(1_000_000);
    });

    it("never yields a pair outside the MARKET_SYMBOLS allowlist, even when it ranks top-N on both exchanges", async () => {
        mockUpstream({
            kraken: { symbols: [{ symbol: "BTC" }, { symbol: "DOGE" }, { symbol: "ETH" }, { symbol: "SOL" }] },
            coinbase: { symbols: [{ symbol: "BTC" }, { symbol: "DOGE" }, { symbol: "ETH" }, { symbol: "SOL" }] },
            // DOGE outranks SOL — the market-cap gate alone would keep it.
            coingecko: { rows: [mcapRow("btc", 1), mcapRow("eth", 2), mcapRow("doge", 3), mcapRow("sol", 4)] },
        });

        // Default allow = config.marketSymbols (BTC/ETH/SOL).
        const candidates = await discoverSyncCandidates(4);

        expect(candidates.map((c) => c.ourSymbol)).toEqual(["BTC/USD", "ETH/USD", "SOL/USD"]);
    });

    it("propagates a CoinGecko fetch failure — the whole call rejects, no candidates", async () => {
        mockUpstream({
            kraken: { symbols: [{ symbol: "BTC" }, { symbol: "ETH" }, { symbol: "SOL" }] },
            coinbase: { symbols: [{ symbol: "BTC" }, { symbol: "ETH" }, { symbol: "SOL" }] },
            coingecko: { rows: [mcapRow("btc", 1), mcapRow("eth", 2), mcapRow("sol", 3)], status: 500 },
        });

        await expect(discoverSyncCandidates(3)).rejects.toThrow(/HTTP 500/);
    });
});

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

/**
 * Every currently-active base symbol for an exchange, straight from the DB —
 * used to keep pre-existing/leftover fixture rows from OTHER test files
 * (e.g. tests/v1-contracts.test.ts, which doesn't clean up its fixtures)
 * "online" in every mocked exchange response below. Without this, checkDelistings'
 * unscoped "all active exchange_symbol_map rows" query would treat any such
 * leftover row as delisted the moment it's missing from a mock that was only
 * ever meant to describe THIS test's own fixture.
 */
async function getActiveBaseSymbols(exchange: "kraken" | "coinbase"): Promise<string[]> {
    const { rows } = await pool.query<{ symbol: string }>(
        `SELECT a.symbol
         FROM exchange_symbol_map esm
         JOIN trading_pairs tp ON tp.id = esm.pair_id
         JOIN assets a ON a.id = tp.base_asset_id
         WHERE esm.exchange = $1 AND esm.is_active = true`,
        [exchange],
    );
    return rows.map((r) => r.symbol);
}

describe("checkDelistings", () => {
    let uid: string;
    let quoteAssetId: string;
    let originalFetch: typeof fetch;
    let backgroundKrakenBases: string[];
    let backgroundCoinbaseBases: string[];
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

        // Snapshot BEFORE this test's own fixture exists, so its own pair is
        // never accidentally included as "background".
        backgroundKrakenBases = await getActiveBaseSymbols("kraken");
        backgroundCoinbaseBases = await getActiveBaseSymbols("coinbase");
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
        const allKrakenBases = [...new Set([...backgroundKrakenBases, ...krakenOnlineBases])];
        const allCoinbaseBases = [...new Set([...backgroundCoinbaseBases, ...coinbaseOnlineBases])];

        global.fetch = (async (url: string | URL | Request) => {
            const href = url.toString();
            if (href.includes("kraken.com")) {
                const result: Record<string, unknown> = {};
                for (const base of allKrakenBases) {
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
                const products = allCoinbaseBases.map((base) => ({
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

describe("upsertCandidate reactivation", () => {
    let uid: string;
    let quoteAssetId: string;
    const createdPairIds: string[] = [];
    const createdAssetIds: string[] = [];

    beforeEach(async () => {
        uid = Math.random().toString(36).slice(2, 8);
        const { rows } = await pool.query<{ id: string }>(
            `INSERT INTO assets (symbol, name, decimals) VALUES ($1, $2, 2) RETURNING id`,
            [`RAQ${uid.toUpperCase()}`, `USD fixture ${uid}`],
        );
        quoteAssetId = rows[0]!.id;
        createdAssetIds.push(quoteAssetId);
    });

    afterEach(async () => {
        if (createdPairIds.length > 0) {
            await pool.query(`DELETE FROM trading_pairs WHERE id = ANY($1)`, [createdPairIds]);
            createdPairIds.length = 0;
        }
        if (createdAssetIds.length > 0) {
            await pool.query(`DELETE FROM assets WHERE id = ANY($1)`, [createdAssetIds]);
            createdAssetIds.length = 0;
        }
    });

    /** A pair that already went through a prior delisting: trading_pairs row
     *  exists but is_active = false, and both exchange_symbol_map rows are
     *  inactive too (matching real post-checkDelistings state). */
    async function createDelistedFixturePair(baseSymbol: string) {
        const { rows: baseRows } = await pool.query<{ id: string }>(
            `INSERT INTO assets (symbol, name, decimals) VALUES ($1, $2, 8) RETURNING id`,
            [baseSymbol, `${baseSymbol} fixture`],
        );
        const baseAssetId = baseRows[0]!.id;

        const { rows: pairRows } = await pool.query<{ id: string }>(
            `INSERT INTO trading_pairs (base_asset_id, quote_asset_id, symbol, is_active)
             VALUES ($1, $2, $3, false) RETURNING id`,
            [baseAssetId, quoteAssetId, `${baseSymbol}/USD-${uid}`],
        );
        const pairId = pairRows[0]!.id;

        await pool.query(
            `INSERT INTO exchange_symbol_map (pair_id, exchange, ws_symbol, rest_symbol, is_active)
             VALUES ($1, 'kraken', $2, $2, false), ($1, 'coinbase', $3, $3, false)`,
            [pairId, `${baseSymbol}/USD`, `${baseSymbol}-USD`],
        );

        return { pairId, baseAssetId, baseSymbol };
    }

    it("flips trading_pairs.is_active back to true when a previously-delisted pair is rediscovered online", async () => {
        const relisted = await createDelistedFixturePair(`RA${uid.toUpperCase()}`);
        createdPairIds.push(relisted.pairId);
        createdAssetIds.push(relisted.baseAssetId);

        const candidate: SyncCandidate = {
            ourSymbol: `${relisted.baseSymbol}/USD-${uid}`,
            baseSymbol: relisted.baseSymbol,
            baseName: relisted.baseSymbol,
            quoteSymbol: `RAQ${uid.toUpperCase()}`,
            volumeUsd24h: 1000,
            kraken: { wsSymbol: `${relisted.baseSymbol}/USD`, restSymbol: `${relisted.baseSymbol}USD` },
            coinbase: { wsSymbol: `${relisted.baseSymbol}-USD`, restSymbol: `${relisted.baseSymbol}-USD` },
        };

        const client = await pool.connect();
        let result: Awaited<ReturnType<typeof upsertCandidate>>;
        try {
            result = await upsertCandidate(client, candidate);
        } finally {
            client.release();
        }

        // Row already existed — this is a reactivation, not a fresh insert.
        expect(result.isNewPair).toBe(false);
        expect(result.wasReactivated).toBe(true);

        const { rows: pairRows } = await pool.query<{ is_active: boolean }>(
            `SELECT is_active FROM trading_pairs WHERE id = $1`,
            [relisted.pairId],
        );
        expect(pairRows[0]!.is_active).toBe(true);

        const { rows: mapRows } = await pool.query<{ exchange: string; is_active: boolean }>(
            `SELECT exchange, is_active FROM exchange_symbol_map WHERE pair_id = $1 ORDER BY exchange`,
            [relisted.pairId],
        );
        expect(mapRows).toEqual([
            { exchange: "coinbase", is_active: true },
            { exchange: "kraken", is_active: true },
        ]);
    });

    it("does not report wasReactivated for a pair that was already active", async () => {
        const alreadyActive = await createDelistedFixturePair(`RB${uid.toUpperCase()}`);
        createdPairIds.push(alreadyActive.pairId);
        createdAssetIds.push(alreadyActive.baseAssetId);
        // Flip it active first, as if a prior sync run already relisted it.
        await pool.query(`UPDATE trading_pairs SET is_active = true WHERE id = $1`, [alreadyActive.pairId]);

        const candidate: SyncCandidate = {
            ourSymbol: `${alreadyActive.baseSymbol}/USD-${uid}`,
            baseSymbol: alreadyActive.baseSymbol,
            baseName: alreadyActive.baseSymbol,
            quoteSymbol: `RAQ${uid.toUpperCase()}`,
            volumeUsd24h: 1000,
            kraken: { wsSymbol: `${alreadyActive.baseSymbol}/USD`, restSymbol: `${alreadyActive.baseSymbol}USD` },
            coinbase: { wsSymbol: `${alreadyActive.baseSymbol}-USD`, restSymbol: `${alreadyActive.baseSymbol}-USD` },
        };

        const client = await pool.connect();
        let result: Awaited<ReturnType<typeof upsertCandidate>>;
        try {
            result = await upsertCandidate(client, candidate);
        } finally {
            client.release();
        }

        expect(result.isNewPair).toBe(false);
        expect(result.wasReactivated).toBe(false);
    });
});

// ──────────────────────────────────────────────────────────────────────
// Shared fixtures for the prunePairs / deactivatePairsGuarded groups.
//   No exchange_symbol_map rows — neither function joins esm, and their
//   absence makes these pairs invisible to checkDelistings, so its tests
//   can't sweep them. Randomized per-test symbols + tracked-ID cleanup,
//   same convention as checkDelistings' fixtures above.
// ──────────────────────────────────────────────────────────────────────

const pruneCreatedPairIds: string[] = [];
const pruneCreatedAssetIds: string[] = [];
const pruneCreatedUserIds: string[] = [];

async function createPruneUser(uid: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO users (email, email_normalized, password_hash, role)
         VALUES ($1, LOWER($1), 'test-hash', 'USER') RETURNING id`,
        [`prune-${uid}@test.local`],
    );
    pruneCreatedUserIds.push(rows[0]!.id);
    return rows[0]!.id;
}

/** A trading pair with a caller-set mcap_rank_misses and is_active. */
async function createPrunePair(
    uid: string,
    prefix: string,
    quoteAssetId: string,
    opts: { misses?: number; active?: boolean } = {},
): Promise<{ pairId: string; baseSymbol: string }> {
    const baseSymbol = `${prefix}${uid.toUpperCase()}`;
    const { rows: assetRows } = await pool.query<{ id: string }>(
        `INSERT INTO assets (symbol, name, decimals) VALUES ($1, $2, 8) RETURNING id`,
        [baseSymbol, `${baseSymbol} fixture`],
    );
    pruneCreatedAssetIds.push(assetRows[0]!.id);

    const { rows: pairRows } = await pool.query<{ id: string }>(
        `INSERT INTO trading_pairs (base_asset_id, quote_asset_id, symbol, is_active, mcap_rank_misses)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [assetRows[0]!.id, quoteAssetId, `${baseSymbol}/USD-${uid}`, opts.active ?? true, opts.misses ?? 0],
    );
    pruneCreatedPairIds.push(pairRows[0]!.id);
    return { pairId: pairRows[0]!.id, baseSymbol };
}

async function addPosition(userId: string, pairId: string): Promise<void> {
    await pool.query(
        `INSERT INTO positions (user_id, pair_id, base_qty, avg_entry_price)
         VALUES ($1, $2, '0.00100000', '50000.00000000')`,
        [userId, pairId],
    );
}
async function addOpenOrder(userId: string, pairId: string): Promise<void> {
    await pool.query(
        `INSERT INTO orders (user_id, pair_id, side, type, limit_price, qty, qty_filled, status,
                             reserved_wallet_id, reserved_amount, reserved_consumed, competition_id, match_id)
         VALUES ($1, $2, 'BUY', 'LIMIT', '40000', '0.00100000', '0', 'OPEN', NULL, '0', '0', NULL, NULL)`,
        [userId, pairId],
    );
}
async function addActiveTrigger(userId: string, pairId: string): Promise<void> {
    await pool.query(
        `INSERT INTO trigger_orders (user_id, pair_id, kind, side, trigger_price, qty)
         VALUES ($1, $2, 'STOP_MARKET', 'SELL', '40000', '0.00100000')`, // status defaults to 'ACTIVE'
        [userId, pairId],
    );
}

/** Every active pair's base symbol EXCEPT this test's own fixtures — the
 *  prunePairs eligible Set is built from these so the run doesn't churn
 *  (or eventually deactivate) leftover pairs from other test files. Same
 *  idea as checkDelistings' getActiveBaseSymbols background snapshot. */
async function backgroundActiveBaseSymbols(): Promise<string[]> {
    const { rows } = await pool.query<{ symbol: string }>(
        `SELECT DISTINCT a.symbol
         FROM trading_pairs tp JOIN assets a ON a.id = tp.base_asset_id
         WHERE tp.is_active = true`,
    );
    return rows.map((r) => r.symbol);
}

async function readPair(pairId: string): Promise<{ is_active: boolean; mcap_rank_misses: number }> {
    const { rows } = await pool.query<{ is_active: boolean; mcap_rank_misses: number }>(
        `SELECT is_active, mcap_rank_misses FROM trading_pairs WHERE id = $1`,
        [pairId],
    );
    return rows[0]!;
}

async function pruneCleanup(): Promise<void> {
    if (pruneCreatedPairIds.length) {
        await pool.query(`DELETE FROM trigger_orders WHERE pair_id = ANY($1)`, [pruneCreatedPairIds]);
        await pool.query(`DELETE FROM orders WHERE pair_id = ANY($1)`, [pruneCreatedPairIds]);
        await pool.query(`DELETE FROM positions WHERE pair_id = ANY($1)`, [pruneCreatedPairIds]);
        await pool.query(`DELETE FROM trading_pairs WHERE id = ANY($1)`, [pruneCreatedPairIds]);
        pruneCreatedPairIds.length = 0;
    }
    if (pruneCreatedAssetIds.length) {
        await pool.query(`DELETE FROM assets WHERE id = ANY($1)`, [pruneCreatedAssetIds]);
        pruneCreatedAssetIds.length = 0;
    }
    if (pruneCreatedUserIds.length) {
        await pool.query(`DELETE FROM users WHERE id = ANY($1)`, [pruneCreatedUserIds]);
        pruneCreatedUserIds.length = 0;
    }
}

// ──────────────────────────────────────────────────────────────────────
// Group (c): prunePairs — real Postgres. Grace counter + threshold prune.
// ──────────────────────────────────────────────────────────────────────

describe("prunePairs", () => {
    let uid: string;
    let quoteAssetId: string;
    let background: string[];

    beforeEach(async () => {
        uid = Math.random().toString(36).slice(2, 8);
        const { rows } = await pool.query<{ id: string }>(
            `INSERT INTO assets (symbol, name, decimals) VALUES ($1, $2, 2) RETURNING id`,
            [`PQ${uid.toUpperCase()}`, `USD fixture ${uid}`],
        );
        quoteAssetId = rows[0]!.id;
        pruneCreatedAssetIds.push(quoteAssetId);
        // Snapshot every OTHER active pair's base symbol BEFORE this test's
        // fixtures exist, so the eligible Set carries them through untouched.
        background = await backgroundActiveBaseSymbols();
    });

    afterEach(pruneCleanup);

    it("zeroes mcap_rank_misses for an active pair whose symbol is back in the eligible set", async () => {
        const { pairId, baseSymbol } = await createPrunePair(uid, "PA", quoteAssetId, { misses: 5 });

        const result = await prunePairs(new Set([...background, baseSymbol]));

        const after = await readPair(pairId);
        expect(after.mcap_rank_misses).toBe(0);
        expect(after.is_active).toBe(true);
        expect(result.missesReset).toBeGreaterThanOrEqual(1); // secondary — real proof is the re-SELECT
    });

    it("increments mcap_rank_misses for an active pair whose symbol is outside the eligible set", async () => {
        const { pairId } = await createPrunePair(uid, "PB", quoteAssetId, { misses: 3 });

        const result = await prunePairs(new Set(background)); // this pair's symbol deliberately absent

        const after = await readPair(pairId);
        expect(after.mcap_rank_misses).toBe(4);
        expect(after.is_active).toBe(true); // 4 is far below MCAP_PRUNE_GRACE_RUNS
        expect(result.missesIncremented).toBeGreaterThanOrEqual(1);
    });

    it("leaves an inactive pair untouched — no increment on the is_active = true guard", async () => {
        const { pairId } = await createPrunePair(uid, "PC", quoteAssetId, { active: false, misses: 5 });

        await prunePairs(new Set(background)); // this pair's symbol excluded

        const after = await readPair(pairId);
        expect(after.is_active).toBe(false);
        expect(after.mcap_rank_misses).toBe(5); // NOT 6 — the `AND tp.is_active = true` guard held
    });

    it("deactivates a pair that crosses the grace threshold and leaves one just below it active", async () => {
        // A starts at GRACE-1 → increment → GRACE → nominated + deactivated
        const a = await createPrunePair(uid, "PA", quoteAssetId, { misses: MCAP_PRUNE_GRACE_RUNS - 1 });
        // B starts at GRACE-2 → increment → GRACE-1 → still below, survives
        const b = await createPrunePair(uid, "PB", quoteAssetId, { misses: MCAP_PRUNE_GRACE_RUNS - 2 });

        const result = await prunePairs(new Set(background)); // neither symbol eligible

        const afterA = await readPair(a.pairId);
        const afterB = await readPair(b.pairId);

        expect(afterA.is_active).toBe(false);
        expect(afterA.mcap_rank_misses).toBe(MCAP_PRUNE_GRACE_RUNS); // incremented, then this value triggered nomination
        expect(afterB.is_active).toBe(true);
        expect(afterB.mcap_rank_misses).toBe(MCAP_PRUNE_GRACE_RUNS - 1); // evaluated + incremented, just didn't cross
        expect(result.pairsDeactivated).toBeGreaterThanOrEqual(1);
    });

    it("does not nominate a past-threshold pair that holds a live position, but its counter still advances", async () => {
        const userId = await createPruneUser(uid);
        const { pairId } = await createPrunePair(uid, "PD", quoteAssetId, { misses: MCAP_PRUNE_GRACE_RUNS - 1 });
        await addPosition(userId, pairId); // would otherwise cross GRACE-1 → GRACE and be deactivated

        await prunePairs(new Set(background)); // symbol excluded; completes without throwing

        const after = await readPair(pairId);
        expect(after.is_active).toBe(true); // Layer A withheld it — because it's held, not a counter bug
        expect(after.mcap_rank_misses).toBe(MCAP_PRUNE_GRACE_RUNS); // counter still advanced — ready to nominate once the position closes
    });

    it("throws on an empty eligible set and makes no writes", async () => {
        const { pairId } = await createPrunePair(uid, "PA", quoteAssetId, { misses: 5 });
        const before = await readPair(pairId);

        await expect(prunePairs(new Set())).rejects.toThrow(/empty eligible-symbol set/);

        const after = await readPair(pairId);
        expect(after).toEqual(before); // is_active AND mcap_rank_misses both unchanged
    });
});

// ──────────────────────────────────────────────────────────────────────
// Groups (d) + (e): deactivatePairsGuarded — real Postgres.
//   (d) THE safety assertion: called directly on a held pair (bypassing
//       prunePairs' Layer-A filter, as if Layer A had a bug) — must
//       throw, log, and leave is_active verifiably unchanged, proven
//       independently for each of the three holding conditions.
//   (e) the clean-pair positive path.
// ──────────────────────────────────────────────────────────────────────

describe("deactivatePairsGuarded", () => {
    let uid: string;
    let quoteAssetId: string;
    let userId: string;

    beforeEach(async () => {
        uid = Math.random().toString(36).slice(2, 8);
        mockLoggerError.mockClear();
        const { rows } = await pool.query<{ id: string }>(
            `INSERT INTO assets (symbol, name, decimals) VALUES ($1, $2, 2) RETURNING id`,
            [`DQ${uid.toUpperCase()}`, `USD fixture ${uid}`],
        );
        quoteAssetId = rows[0]!.id;
        pruneCreatedAssetIds.push(quoteAssetId);
        userId = await createPruneUser(uid);
    });

    afterEach(pruneCleanup);

    /** Call the guard directly on a single pair inside a transaction and
     *  assert it rejects; ROLLBACK afterward (mirrors prunePairs' catch). */
    async function expectGuardRejects(pairId: string): Promise<void> {
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            await expect(deactivatePairsGuarded(client, [pairId])).rejects.toThrow(/safety assertion failed/);
            await client.query("ROLLBACK");
        } finally {
            client.release();
        }
    }

    // ── (d) safety assertion — one test per PAIR_HOLDS_NOTHING_LIVE_SQL clause ──

    it("throws, logs, and leaves is_active unchanged when the pair holds a non-zero position", async () => {
        const { pairId } = await createPrunePair(uid, "DA", quoteAssetId);
        await addPosition(userId, pairId);

        await expectGuardRejects(pairId);

        expect(mockLoggerError).toHaveBeenCalledWith(
            { blockedPairIds: [pairId] },
            "pair_deactivation_safety_assertion_failed",
        );
        expect((await readPair(pairId)).is_active).toBe(true); // re-SELECTed, not inferred from the throw
    });

    it("throws, logs, and leaves is_active unchanged when the pair holds an OPEN order", async () => {
        const { pairId } = await createPrunePair(uid, "DB", quoteAssetId);
        await addOpenOrder(userId, pairId);

        await expectGuardRejects(pairId);

        expect(mockLoggerError).toHaveBeenCalledWith(
            { blockedPairIds: [pairId] },
            "pair_deactivation_safety_assertion_failed",
        );
        expect((await readPair(pairId)).is_active).toBe(true);
    });

    it("throws, logs, and leaves is_active unchanged when the pair holds an ACTIVE trigger_order", async () => {
        const { pairId } = await createPrunePair(uid, "DC", quoteAssetId);
        await addActiveTrigger(userId, pairId);

        await expectGuardRejects(pairId);

        expect(mockLoggerError).toHaveBeenCalledWith(
            { blockedPairIds: [pairId] },
            "pair_deactivation_safety_assertion_failed",
        );
        expect((await readPair(pairId)).is_active).toBe(true);
    });

    // ── (e) clean-pair positive path ──

    it("deactivates a pair that holds nothing live and returns its id", async () => {
        const { pairId } = await createPrunePair(uid, "DD", quoteAssetId);

        const client = await pool.connect();
        let deactivated: string[];
        try {
            await client.query("BEGIN");
            deactivated = await deactivatePairsGuarded(client, [pairId]);
            await client.query("COMMIT");
        } finally {
            client.release();
        }

        expect(deactivated).toEqual([pairId]);
        expect((await readPair(pairId)).is_active).toBe(false); // re-SELECTed after COMMIT
        expect(mockLoggerError).not.toHaveBeenCalled();
    });

    it("returns an empty array and touches nothing when called with no pair ids", async () => {
        const { pairId } = await createPrunePair(uid, "DE", quoteAssetId);

        const client = await pool.connect();
        let result: string[];
        try {
            await client.query("BEGIN");
            result = await deactivatePairsGuarded(client, []);
            await client.query("COMMIT");
        } finally {
            client.release();
        }

        expect(result).toEqual([]);
        expect((await readPair(pairId)).is_active).toBe(true);
    });
});
