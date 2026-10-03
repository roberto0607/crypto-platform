/**
 * pairAllowlist.test.ts — the MARKET_SYMBOLS allowlist gates tradability,
 * not just stored candles.
 *
 * Two fixture pairs, identical in every way the old code looked at (active,
 * exchange-backed on Kraken + Coinbase, priced): one admitted to the
 * allowlist via allowSymbolForTest(), one not. Every surface must show/accept
 * the first and hide/reject the second.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, registerAndLogin, getPool } from "./helpers";
import { allowSymbolForTest } from "../src/market/marketSymbols";
import { listActivePairs, listActivePairsForDisplay } from "../src/trading/pairRepo";
import { loadActiveSymbols } from "../src/market/symbolRegistry";
import { placeOrderTx } from "../src/trading/matchingEngine";
import { computeChangePct, resetPublicTickerCache } from "../src/market/publicTickers";

let app: FastifyInstance;
let traderToken: string;
let traderId: string;
let allowedPairId: string;
let blockedPairId: string;
let blockedSymbol: string;
const createdPairIds: string[] = [];
const createdAssetIds: string[] = [];

const uid = Math.random().toString(36).slice(2, 7).toUpperCase();

async function createExchangeBackedPair(baseSymbol: string, pairSymbol: string, quoteAssetId: string) {
    const pool = getPool();
    const { rows: [base] } = await pool.query<{ id: string }>(
        `INSERT INTO assets (symbol, name, decimals) VALUES ($1, $1, 8) RETURNING id`,
        [baseSymbol],
    );
    createdAssetIds.push(base!.id);
    const { rows: [pair] } = await pool.query<{ id: string }>(
        `INSERT INTO trading_pairs (base_asset_id, quote_asset_id, symbol, is_active, last_price, fee_bps)
         VALUES ($1, $2, $3, true, '100.00000000', 0) RETURNING id`,
        [base!.id, quoteAssetId, pairSymbol],
    );
    createdPairIds.push(pair!.id);
    await pool.query(
        `INSERT INTO exchange_symbol_map (pair_id, exchange, ws_symbol, rest_symbol, is_active)
         VALUES ($1, 'kraken', $2, $2, true), ($1, 'coinbase', $3, $3, true)`,
        [pair!.id, pairSymbol, pairSymbol.replace("/", "-")],
    );
    return pair!.id;
}

beforeAll(async () => {
    app = await getTestApp();
    const pool = getPool();

    const trader = await registerAndLogin(app, "allowlist-trader");
    traderToken = trader.accessToken;
    traderId = trader.userId;

    const { rows: [quote] } = await pool.query<{ id: string }>(
        `INSERT INTO assets (symbol, name, decimals) VALUES ($1, 'quote fixture', 2) RETURNING id`,
        [`Q${uid}`],
    );
    createdAssetIds.push(quote!.id);

    allowedPairId = await createExchangeBackedPair(`A${uid}`, allowSymbolForTest(`A${uid}/USD`), quote!.id);
    blockedSymbol = `Z${uid}/USD`;
    blockedPairId = await createExchangeBackedPair(`Z${uid}`, blockedSymbol, quote!.id);
});

afterAll(async () => {
    const pool = getPool();
    await pool.query(`DELETE FROM alerts WHERE pair_id = ANY($1)`, [createdPairIds]).catch(() => {});
    await pool.query(`DELETE FROM candles WHERE pair_id = ANY($1)`, [createdPairIds]);
    await pool.query(`DELETE FROM trigger_orders WHERE pair_id = ANY($1)`, [createdPairIds]);
    await pool.query(`DELETE FROM orders WHERE pair_id = ANY($1)`, [createdPairIds]);
    await pool.query(`DELETE FROM trading_pairs WHERE id = ANY($1)`, [createdPairIds]);
    await pool.query(`DELETE FROM wallets WHERE asset_id = ANY($1)`, [createdAssetIds]);
    await pool.query(`DELETE FROM assets WHERE id = ANY($1)`, [createdAssetIds]);
    await closeTestApp();
});

describe("pair listings", () => {
    it("GET /pairs lists the allowlisted pair and hides the other", async () => {
        const res = await app.inject({
            method: "GET",
            url: "/pairs",
            headers: { authorization: `Bearer ${traderToken}` },
        });
        expect(res.statusCode).toBe(200);
        const ids = res.json().pairs.map((p: { id: string }) => p.id);
        expect(ids).toContain(allowedPairId);
        expect(ids).not.toContain(blockedPairId);
    });

    it("GET /pairs?search never surfaces a non-allowlisted pair, even on an exact match", async () => {
        const res = await app.inject({
            method: "GET",
            url: `/pairs?search=${encodeURIComponent(blockedSymbol)}`,
            headers: { authorization: `Bearer ${traderToken}` },
        });
        expect(res.statusCode).toBe(200);
        // Fuzzy search may still surface the allowlisted fixture; never the blocked one.
        const ids = res.json().pairs.map((p: { id: string }) => p.id);
        expect(ids).not.toContain(blockedPairId);
    });

    it("GET /v1/pairs hides the non-allowlisted pair", async () => {
        const res = await app.inject({
            method: "GET",
            url: "/v1/pairs?limit=100",
            headers: { authorization: `Bearer ${traderToken}` },
        });
        expect(res.statusCode).toBe(200);
        const ids = res.json().data.map((p: { id: string }) => p.id);
        expect(ids).toContain(allowedPairId);
        expect(ids).not.toContain(blockedPairId);
    });

    it("internal listActivePairs (market maker, candle sync) excludes it", async () => {
        const ids = (await listActivePairs()).map((p) => p.id);
        expect(ids).toContain(allowedPairId);
        expect(ids).not.toContain(blockedPairId);
        const displayIds = (await listActivePairsForDisplay({})).map((p) => p.id);
        expect(displayIds).not.toContain(blockedPairId);
    });
});

describe("exchange feeds", () => {
    it("Kraken and Coinbase subscribe only to allowlisted pairs", async () => {
        for (const exchange of ["kraken", "coinbase"] as const) {
            const pairIds = (await loadActiveSymbols(exchange)).map((s) => s.pairId);
            expect(pairIds).toContain(allowedPairId);
            expect(pairIds).not.toContain(blockedPairId);
        }
    });
});

describe("placement is rejected with pair_not_tradable", () => {
    it("POST /orders → 400 with the allowed symbols, and nothing is written", async () => {
        const res = await app.inject({
            method: "POST",
            url: "/orders",
            headers: { authorization: `Bearer ${traderToken}` },
            payload: { pairId: blockedPairId, side: "BUY", type: "MARKET", qty: "0.01" },
        });
        expect(res.statusCode).toBe(400);
        expect(res.json().error).toBe("pair_not_tradable");
        expect(res.json().details.allowedSymbols).toEqual(expect.arrayContaining(["BTC/USD", "ETH/USD", "SOL/USD"]));
        expect(res.json().details.allowedSymbols).not.toContain(blockedSymbol);

        const { rows } = await getPool().query(`SELECT 1 FROM orders WHERE pair_id = $1`, [blockedPairId]);
        expect(rows).toHaveLength(0);
    });

    it("POST /v1/triggers → 400", async () => {
        const res = await app.inject({
            method: "POST",
            url: "/v1/triggers",
            headers: { authorization: `Bearer ${traderToken}` },
            payload: { pairId: blockedPairId, kind: "STOP_MARKET", side: "SELL", triggerPrice: "90", qty: "1" },
        });
        expect(res.statusCode).toBe(400);
        expect(res.json().code).toBe("pair_not_tradable");
    });

    it("POST /v1/oco → 400", async () => {
        const res = await app.inject({
            method: "POST",
            url: "/v1/oco",
            headers: { authorization: `Bearer ${traderToken}` },
            payload: {
                pairId: blockedPairId,
                legA: { kind: "STOP_MARKET", side: "SELL", triggerPrice: "90", qty: "1" },
                legB: { kind: "TAKE_PROFIT_MARKET", side: "SELL", triggerPrice: "110", qty: "1" },
            },
        });
        expect(res.statusCode).toBe(400);
        expect(res.json().code).toBe("pair_not_tradable");
    });

    it("POST /v1/alerts → 400", async () => {
        const res = await app.inject({
            method: "POST",
            url: "/v1/alerts",
            headers: { authorization: `Bearer ${traderToken}` },
            payload: { pairId: blockedPairId, conditionType: "CROSSING", targetValue: "120", frequency: "ONCE" },
        });
        expect(res.statusCode).toBe(400);
        expect(res.json().code).toBe("pair_not_tradable");
    });

    it("POST /replay/start → 400", async () => {
        const res = await app.inject({
            method: "POST",
            url: "/replay/start",
            headers: { authorization: `Bearer ${traderToken}` },
            payload: { pairId: blockedPairId, startTs: "2026-01-01T00:00:00.000Z" },
        });
        expect(res.statusCode).toBe(400);
        expect(res.json().error).toBe("pair_not_tradable");
    });

    it("the matching engine itself refuses (backstop for agents / trigger engine)", async () => {
        const client = await getPool().connect();
        try {
            await client.query("BEGIN");
            await expect(
                placeOrderTx(client, traderId, blockedPairId, "BUY", "MARKET", "0.01", undefined, null, null, null),
            ).rejects.toThrow("pair_not_tradable");
        } finally {
            await client.query("ROLLBACK");
            client.release();
        }
    });
});

describe("GET /v1/market/tickers (public, pre-login ticker)", () => {
    it("needs no auth, lists only allowlisted pairs, with a real 24h change", async () => {
        // last_price is 100; a 1h candle that closed at 80 25h ago → +25%.
        await getPool().query(
            `INSERT INTO candles (pair_id, timeframe, ts, open, high, low, close, volume)
             VALUES ($1, '1h', date_trunc('hour', now() - interval '25 hours'), 80, 80, 80, 80, 1)`,
            [allowedPairId],
        );
        resetPublicTickerCache();

        const res = await app.inject({ method: "GET", url: "/v1/market/tickers" });
        expect(res.statusCode).toBe(200);
        const data = res.json().data as { symbol: string; price: string | null; change24hPct: number | null }[];
        const symbols = data.map((t) => t.symbol);
        expect(symbols).toContain(`A${uid}/USD`);
        expect(symbols).not.toContain(blockedSymbol);
        const allowed = data.find((t) => t.symbol === `A${uid}/USD`)!;
        expect(Number(allowed.price)).toBe(100);
        expect(allowed.change24hPct).toBe(25);
    });

    it("computeChangePct rounds to 2dp and returns null without a usable reference", () => {
        expect(computeChangePct("84220.44", "82320")).toBe(2.31);
        expect(computeChangePct("99", "100")).toBe(-1);
        expect(computeChangePct("100", null)).toBeNull();
        expect(computeChangePct(null, "100")).toBeNull();
        expect(computeChangePct("100", "0")).toBeNull();
    });
});
