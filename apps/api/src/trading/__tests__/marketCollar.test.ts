/**
 * marketCollar.test.ts — the market-order price collar in the matching engine,
 * including a regression replay of both 2026-10-01 prod bad fills.
 *
 * Both prod fills were MARKET BUYs that lifted a market-maker 5bps ask
 * (maker mmbot@system.local, is_system_fill=false). Reconstructed from the prod
 * `mm_quoted` log and Kraken XBT/USD 5m OHLC (fill times are US/Eastern):
 *
 *   #1  14:39:49 ET (18:39:49Z)  fill 84818.68
 *       MM quoted at 18:20:01Z, mid 84776.30 → 5bps ask 84818.68 (rounded down). By the fill,
 *       Kraken had risen to ~85137 (18:35 bar: h 85238.6, c 85137.4) — the ask
 *       sat ~37bps BELOW market, under the old 50bps requote threshold.
 *
 *   #2  21:16:01 ET (01:16:01Z)  fill 84699.32
 *       MM quoted at 01:13:05Z, mid 84657.00 → 5bps ask 84699.32 (rounded down). At the fill,
 *       Kraken traded ~84611–84680 (01:15 bar: o 84638.1, h 84680.5) — the ask
 *       sat ~7bps above Kraken, i.e. the MM's own 5bps half-spread plus ~2bps
 *       of drift on a 3-minute-old quote.
 *
 * Real Postgres; the Kraken book reference is seeded in-process.
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { pool } from "../../db/pool";
import { placeOrder } from "../matchingEngine";
import { resetTestData, ensureMigrations } from "../../testing/resetDb";
import { createTestUser, createTestAssetAndPair, createTestWallets } from "../../testing/fixtures";
import { seedReferenceBook, clearReferenceBooks } from "../../testing/referenceBook";
import { config } from "../../config";

let maker: { id: string };
let taker: { id: string };
let pairId: string;

async function restingOrder(id: string) {
    const { rows } = await pool.query<{ status: string; qty_filled: string }>(
        `SELECT status, qty_filled::text FROM orders WHERE id = $1`,
        [id],
    );
    return rows[0];
}

async function setLastPrice(price: string) {
    await pool.query(`UPDATE trading_pairs SET last_price = $1, fee_bps = 0 WHERE id = $2`, [price, pairId]);
}

beforeAll(async () => {
    await ensureMigrations();
});

beforeEach(async () => {
    await resetTestData();
    clearReferenceBooks();
    maker = await createTestUser(pool);
    taker = await createTestUser(pool);
    const assets = await createTestAssetAndPair(pool);
    pairId = assets.pair.id;
    await createTestWallets(pool, maker.id, assets.btcAsset.id, assets.usdAsset.id, "10.00000000", "1000000.00000000");
    await createTestWallets(pool, taker.id, assets.btcAsset.id, assets.usdAsset.id, "10.00000000", "1000000.00000000");
});

describe("prod fill #1 (84818.68, 2026-10-01 14:39:49 ET) — now impossible", () => {
    it("a MARKET BUY no longer lifts the stale 84818.68 MM ask; it system-fills at market instead", async () => {
        await setLastPrice("85137.40000000");
        const mmAsk = await placeOrder(maker.id, pairId, "SELL", "LIMIT", "0.50000000", "84818.68000000");
        seedReferenceBook(pairId, "85137.3", "85137.4"); // Kraken at the fill

        const result = await placeOrder(taker.id, pairId, "BUY", "MARKET", "0.10000000");

        expect(result.fills.every((f) => f.is_system_fill)).toBe(true);
        expect(result.fills.map((f) => f.price)).not.toContain("84818.68000000");
        expect(await restingOrder(mmAsk.order.id)).toEqual({ status: "OPEN", qty_filled: "0.00000000" });
    });

    it("control: with the collar out of the way the same book reproduces the prod fill", async () => {
        // Proves the scenario above is the real one — without the collar, the
        // engine sweeps the stale ask exactly as prod did.
        const saved = config.marketCollarBps;
        config.marketCollarBps = 100_000;
        try {
            await setLastPrice("85137.40000000");
            await placeOrder(maker.id, pairId, "SELL", "LIMIT", "0.50000000", "84818.68000000");
            seedReferenceBook(pairId, "85137.3", "85137.4");
            const result = await placeOrder(taker.id, pairId, "BUY", "MARKET", "0.10000000");
            expect(result.fills).toHaveLength(1);
            expect(result.fills[0].price).toBe("84818.68000000");
            expect(result.fills[0].is_system_fill).toBe(false);
        } finally {
            config.marketCollarBps = saved;
        }
    });
});

describe("prod fill #2 (84699.32, 2026-10-01 21:16:01 ET) — NOT prevented by the collar", () => {
    it("the 84699.32 ask was ~7bps from Kraken, inside the 25bps collar, so it still fills", async () => {
        // Characterization, deliberately not `it.fails`: this fill was the MM's
        // normal 5bps half-spread on a 3-minute-old quote (mid had moved ~2bps,
        // under the 10bps requote threshold too). Neither the collar nor the MM
        // changes block it; making it impossible needs a tighter MM spread or
        // a collar under ~5bps, which would also exclude the MM's tightest quotes.
        await setLastPrice("84638.10000000");
        await placeOrder(maker.id, pairId, "SELL", "LIMIT", "0.50000000", "84699.32000000");
        seedReferenceBook(pairId, "84638.0", "84638.1"); // Kraken 01:15 bar open

        const result = await placeOrder(taker.id, pairId, "BUY", "MARKET", "0.10000000");

        expect(result.fills).toHaveLength(1);
        expect(result.fills[0].price).toBe("84699.32000000");
        expect(result.fills[0].is_system_fill).toBe(false);
    });
});

describe("collar — general", () => {
    it("rejects a MARKET order with stale_price_source when the Kraken book is older than 5s, touching nothing", async () => {
        await setLastPrice("85000.00000000");
        const ask = await placeOrder(maker.id, pairId, "SELL", "LIMIT", "0.50000000", "85010.00000000");
        seedReferenceBook(pairId, "85000", "85001", 5_001);

        await expect(placeOrder(taker.id, pairId, "BUY", "MARKET", "0.10000000")).rejects.toThrow("stale_price_source");

        expect(await restingOrder(ask.order.id)).toEqual({ status: "OPEN", qty_filled: "0.00000000" });
        const { rows } = await pool.query(`SELECT 1 FROM orders WHERE user_id = $1`, [taker.id]);
        expect(rows).toHaveLength(0); // rolled back — no order row
    });

    it("rejects a MARKET order with stale_price_source when there is no Kraken book at all", async () => {
        await setLastPrice("85000.00000000");
        await expect(placeOrder(taker.id, pairId, "SELL", "MARKET", "0.10000000")).rejects.toThrow("stale_price_source");
    });

    it("a MARKET BUY fills asks inside the band, skips asks outside it on both sides", async () => {
        await setLastPrice("80000.00000000");
        seedReferenceBook(pairId, "79999", "80000"); // band 79800–80200
        const tooCheap = await placeOrder(maker.id, pairId, "SELL", "LIMIT", "0.10000000", "79799.00000000");
        const inside = await placeOrder(maker.id, pairId, "SELL", "LIMIT", "0.10000000", "80150.00000000");
        const tooRich = await placeOrder(maker.id, pairId, "SELL", "LIMIT", "0.10000000", "80201.00000000");

        const result = await placeOrder(taker.id, pairId, "BUY", "MARKET", "0.30000000");

        const book = result.fills.filter((f) => !f.is_system_fill);
        expect(book.map((f) => f.price)).toEqual(["80150.00000000"]);
        expect(result.fills.filter((f) => f.is_system_fill)).toHaveLength(1); // rest at market
        expect((await restingOrder(inside.order.id)).status).toBe("FILLED");
        expect((await restingOrder(tooCheap.order.id)).status).toBe("OPEN");
        expect((await restingOrder(tooRich.order.id)).status).toBe("OPEN");
    });

    it("a MARKET SELL is banded around Kraken's best bid and skips a stale-high bid", async () => {
        await setLastPrice("80000.00000000");
        seedReferenceBook(pairId, "80000", "80001"); // band 79800–80200
        const staleHigh = await placeOrder(maker.id, pairId, "BUY", "LIMIT", "0.10000000", "80300.00000000");
        const inside = await placeOrder(maker.id, pairId, "BUY", "LIMIT", "0.10000000", "79900.00000000");

        const result = await placeOrder(taker.id, pairId, "SELL", "MARKET", "0.10000000");

        expect(result.fills).toHaveLength(1);
        expect(result.fills[0].price).toBe("79900.00000000");
        expect((await restingOrder(staleHigh.order.id)).status).toBe("OPEN");
        expect((await restingOrder(inside.order.id)).status).toBe("FILLED");
    });

    it("LIMIT orders are not collared and need no Kraken book", async () => {
        await setLastPrice("80000.00000000");
        await placeOrder(maker.id, pairId, "SELL", "LIMIT", "0.10000000", "75000.00000000");
        const result = await placeOrder(taker.id, pairId, "BUY", "LIMIT", "0.10000000", "75000.00000000");
        expect(result.fills).toHaveLength(1);
    });
});
