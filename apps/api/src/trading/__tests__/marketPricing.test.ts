/**
 * marketPricing.test.ts — B1: MARKET fills priced from the real Kraken touch.
 *
 *   - Fresh Kraken book (≤5s)       → system fill at best ask (BUY) / best bid (SELL), no spread.
 *   - Book stale, ticker fresh (≤10s) → system fill at the ticker's ask / bid.
 *   - Both stale (or no bid/ask)    → reject stale_price_source. Never trading_pairs.last_price.
 *   - Sweep cap: a MARKET order lifts resting quotes only at the touch or better,
 *     so no MARKET fill is ever worse than the Kraken touch.
 *   - A fill only moves last_price when it printed on-market (the $63,566 poisoning).
 *
 * Real Postgres; the Kraken book and ticker are seeded in-process.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { pool } from "../../db/pool";
import { placeOrder } from "../matchingEngine";
import { resetTestData, ensureMigrations } from "../../testing/resetDb";
import { createTestUser, createTestAssetAndPair, createTestWallets } from "../../testing/fixtures";
import { seedReferenceBook, seedTicker, clearReferenceBooks } from "../../testing/referenceBook";
import { D } from "../../utils/decimal";

const SYMBOL = "BTC/USD"; // createTestAssetAndPair's pair
let maker: { id: string };
let taker: { id: string };
let pairId: string;

async function lastPrice(): Promise<string> {
    const { rows } = await pool.query<{ last_price: string }>(`SELECT last_price::text FROM trading_pairs WHERE id = $1`, [pairId]);
    return rows[0].last_price;
}

async function setLastPrice(price: string) {
    await pool.query(`UPDATE trading_pairs SET last_price = $1, fee_bps = 0 WHERE id = $2`, [price, pairId]);
}

/** Pretend `ms` pass: ages every seeded book and ticker. */
function advance(ms: number) {
    vi.setSystemTime(Date.now() + ms);
}

beforeAll(async () => {
    await ensureMigrations();
});

beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await resetTestData();
    clearReferenceBooks();
    maker = await createTestUser(pool);
    taker = await createTestUser(pool);
    const assets = await createTestAssetAndPair(pool);
    pairId = assets.pair.id;
    await createTestWallets(pool, maker.id, assets.btcAsset.id, assets.usdAsset.id, "10.00000000", "2000000.00000000");
    await createTestWallets(pool, taker.id, assets.btcAsset.id, assets.usdAsset.id, "10.00000000", "2000000.00000000");
    await setLastPrice("84600.00000000");
});

afterEach(() => {
    vi.useRealTimers();
});

describe("fresh Kraken book", () => {
    it("a MARKET BUY system-fills at exactly the best ask, a SELL at exactly the best bid", async () => {
        seedReferenceBook(pairId, "84600.0", "84600.1");

        const buy = await placeOrder(taker.id, pairId, "BUY", "MARKET", "0.10000000");
        expect(buy.fills).toHaveLength(1);
        expect(buy.fills[0]).toMatchObject({ price: "84600.10000000", is_system_fill: true });
        expect(buy.reference?.source).toBe("book");

        const sell = await placeOrder(taker.id, pairId, "SELL", "MARKET", "0.10000000");
        expect(sell.fills[0]).toMatchObject({ price: "84600.00000000", is_system_fill: true });
    });

    it("prefers the book over a fresh ticker", async () => {
        seedReferenceBook(pairId, "84600.0", "84600.1");
        await seedTicker(SYMBOL, "84500", "84501");
        const buy = await placeOrder(taker.id, pairId, "BUY", "MARKET", "0.10000000");
        expect(buy.fills[0].price).toBe("84600.10000000");
    });

    it("a stale-but-just-fresh book (5s) still prices the fill", async () => {
        seedReferenceBook(pairId, "84600.0", "84600.1", 5_000);
        const buy = await placeOrder(taker.id, pairId, "BUY", "MARKET", "0.10000000");
        expect(buy.reference?.source).toBe("book");
    });
});

describe("book stale → Kraken ticker fallback", () => {
    it("fills at the ticker ask/bid when the book is >5s old and the ticker ≤10s", async () => {
        await seedTicker(SYMBOL, "84550.5", "84551.5");
        seedReferenceBook(pairId, "84600.0", "84600.1", 6_000);
        advance(9_000); // ticker 9s old; book 15s old

        const buy = await placeOrder(taker.id, pairId, "BUY", "MARKET", "0.10000000");
        expect(buy.reference?.source).toBe("ticker");
        expect(buy.fills[0]).toMatchObject({ price: "84551.50000000", is_system_fill: true });

        const sell = await placeOrder(taker.id, pairId, "SELL", "MARKET", "0.10000000");
        expect(sell.fills[0].price).toBe("84550.50000000");
    });

    it("rejects stale_price_source once the ticker is >10s old too, touching nothing", async () => {
        await seedTicker(SYMBOL, "84550.5", "84551.5");
        seedReferenceBook(pairId, "84600.0", "84600.1");
        advance(10_001);

        await expect(placeOrder(taker.id, pairId, "BUY", "MARKET", "0.10000000")).rejects.toThrow("stale_price_source");
        const { rows } = await pool.query(`SELECT 1 FROM orders WHERE user_id = $1`, [taker.id]);
        expect(rows).toHaveLength(0);
        expect(await lastPrice()).toBe("84600.00000000");
    });

    it("rejects a ticker that has no bid/ask rather than inventing a spread around last", async () => {
        await seedTicker(SYMBOL, null, null, "84551");
        await expect(placeOrder(taker.id, pairId, "BUY", "MARKET", "0.10000000")).rejects.toThrow("stale_price_source");
    });

    it("never prices off trading_pairs.last_price: no book, no ticker → reject even though last_price is set", async () => {
        // Pre-B1 this filled at last_price ± spread (the "fallback" snapshot, stamped as fresh).
        await expect(placeOrder(taker.id, pairId, "SELL", "MARKET", "0.10000000")).rejects.toThrow("stale_price_source");
    });
});

describe("sweep cap: a MARKET fill is never worse than the Kraken touch", () => {
    // Kraken 84600.0 / 84600.1; MM quotes ±5bps around a 84600.05 mid.
    const mid = D("84600.05");

    it("a BUY skips an MM ask above the best ask and system-fills everything at the ask", async () => {
        seedReferenceBook(pairId, "84600.0", "84600.1");
        const mmAsk = mid.mul("1.0005").toFixed(2); // 84642.35 — the MM's fresh 5bps ask
        const resting = await placeOrder(maker.id, pairId, "SELL", "LIMIT", "0.05000000", mmAsk);

        const buy = await placeOrder(taker.id, pairId, "BUY", "MARKET", "0.10000000");

        expect(buy.fills.map((f) => [f.price, f.is_system_fill])).toEqual([["84600.10000000", true]]);
        const { rows } = await pool.query(`SELECT status FROM orders WHERE id = $1`, [resting.order.id]);
        expect(rows[0].status).toBe("OPEN");
    });

    it("a SELL skips an MM bid below the best bid and system-fills everything at the bid", async () => {
        seedReferenceBook(pairId, "84600.0", "84600.1");
        const mmBid = mid.mul("0.9995").toFixed(2); // 84557.75 — the MM's fresh 5bps bid
        await placeOrder(maker.id, pairId, "BUY", "LIMIT", "0.05000000", mmBid);

        const sell = await placeOrder(taker.id, pairId, "SELL", "MARKET", "0.10000000");

        expect(sell.fills.map((f) => [f.price, f.is_system_fill])).toEqual([["84600.00000000", true]]);
    });

    it("an MM quote better than the touch still fills first, the rest at the touch", async () => {
        // The MM quoted around an older mid ~8bps away from Kraken (under the
        // 10bps requote threshold), so one of its quotes sits on the taker's
        // side of the touch. BUY: a low-mid ask under the Kraken ask.
        seedReferenceBook(pairId, "84600.0", "84600.1");
        const staleMid = D("84532.40");                      // ~8bps under Kraken
        const mmAsk = staleMid.mul("1.0005").toFixed(2);     // 84574.66 < 84600.1
        await placeOrder(maker.id, pairId, "SELL", "LIMIT", "0.05000000", mmAsk);

        const buy = await placeOrder(taker.id, pairId, "BUY", "MARKET", "0.10000000");

        expect(buy.fills.map((f) => [f.price, f.is_system_fill])).toEqual([
            [`${mmAsk}000000`, false],
            ["84600.10000000", true],
        ]);

        // Mirror for a SELL: an MM bid quoted off a higher mid sits above the Kraken bid.
        const highMid = D("84668.00");                        // ~8bps over Kraken
        const mmBid = highMid.mul("0.9995").toFixed(2);       // 84625.66 > 84600.0
        await placeOrder(maker.id, pairId, "BUY", "LIMIT", "0.05000000", mmBid);

        const sell = await placeOrder(taker.id, pairId, "SELL", "MARKET", "0.10000000");

        expect(sell.fills.map((f) => [f.price, f.is_system_fill])).toEqual([
            [`${mmBid}000000`, false],
            ["84600.00000000", true],
        ]);
    });

    it("a resting quote exactly at the touch still fills (inclusive cap)", async () => {
        seedReferenceBook(pairId, "84600.0", "84600.1");
        await placeOrder(maker.id, pairId, "SELL", "LIMIT", "0.10000000", "84600.10000000");

        const buy = await placeOrder(taker.id, pairId, "BUY", "MARKET", "0.10000000");

        expect(buy.fills.map((f) => [f.price, f.is_system_fill])).toEqual([["84600.10000000", false]]);
    });

    it("a stale reference still rejects stale_price_source, leaving resting quotes untouched", async () => {
        seedReferenceBook(pairId, "84600.0", "84600.1");
        const resting = await placeOrder(maker.id, pairId, "SELL", "LIMIT", "0.05000000", "84590.00000000");
        advance(10_001); // book and (absent) ticker both stale

        await expect(placeOrder(taker.id, pairId, "BUY", "MARKET", "0.10000000")).rejects.toThrow("stale_price_source");
        const { rows } = await pool.query(`SELECT status, qty_filled::text FROM orders WHERE id = $1`, [resting.order.id]);
        expect(rows[0]).toEqual({ status: "OPEN", qty_filled: "0.00000000" });
    });
});

describe("last_price only moves on on-market fills", () => {
    it("the $63,566 case: an off-market LIMIT cross between users does not poison last_price", async () => {
        seedReferenceBook(pairId, "84600.0", "84600.1");
        await placeOrder(maker.id, pairId, "SELL", "LIMIT", "0.01000000", "63566.00000000");
        const cross = await placeOrder(taker.id, pairId, "BUY", "LIMIT", "0.01000000", "63566.00000000");

        expect(cross.fills[0].price).toBe("63566.00000000"); // the trade itself is allowed
        expect(await lastPrice()).toBe("84600.00000000");    // the live price is not moved by it
    });

    it("a fill with no fresh reference leaves last_price to the Kraken sync", async () => {
        await placeOrder(maker.id, pairId, "SELL", "LIMIT", "0.01000000", "84650.00000000");
        await placeOrder(taker.id, pairId, "BUY", "LIMIT", "0.01000000", "84650.00000000");
        expect(await lastPrice()).toBe("84600.00000000");
    });

    it("an on-market fill does move last_price", async () => {
        seedReferenceBook(pairId, "84600.0", "84600.1");
        await placeOrder(taker.id, pairId, "BUY", "MARKET", "0.10000000");
        expect(await lastPrice()).toBe("84600.10000000");
    });

    it("a replay-session fill (historical price) never moves the live last_price", async () => {
        const replay = { bestBid: D("61000"), bestAsk: D("61000"), ageMs: 0, source: "replay" as const };
        const r = await placeOrder(taker.id, pairId, "BUY", "MARKET", "0.10000000", undefined, null, null, null, replay);
        expect(r.fills[0]).toMatchObject({ price: "61000.00000000", is_system_fill: true });
        expect(await lastPrice()).toBe("84600.00000000");
    });

    it("a replay-session MARKET order needs no live feed and skips live MM quotes", async () => {
        await placeOrder(maker.id, pairId, "SELL", "LIMIT", "0.10000000", "84650.00000000"); // live MM-ish quote
        const replay = { bestBid: D("61000"), bestAsk: D("61000"), ageMs: 0, source: "replay" as const };
        const r = await placeOrder(taker.id, pairId, "BUY", "MARKET", "0.10000000", undefined, null, null, null, replay);
        expect(r.fills.every((f) => f.is_system_fill)).toBe(true);
    });
});
