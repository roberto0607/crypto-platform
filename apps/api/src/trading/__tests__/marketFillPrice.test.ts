/**
 * marketFillPrice: the pure model every MARKET fill, liquidation and match-end
 * close is priced by. Hand-computed cases; see the header of marketFillPrice.ts.
 */
import { describe, it, expect } from "vitest";
import { D } from "../../utils/decimal";
import { priceMarketFill, MAX_BEYOND_BOOK_BPS, type FillModel } from "../marketFillPrice";

const MODEL: FillModel = { touchBandQuote: D("50000"), impactBpsPerBand: D("10") };

// $100 asks: 1,000 at 100 ($100k), 1,000 at 101, 1,000 at 102.
const ASKS = [
    { price: 100, qty: 1000 },
    { price: 101, qty: 1000 },
    { price: 102, qty: 1000 },
];
const BIDS = [
    { price: 99, qty: 1000 },
    { price: 98, qty: 1000 },
];

describe("priceMarketFill", () => {
    it("inside the touch band: exactly the touch, however thin the book", () => {
        const thin = [{ price: 100, qty: 1 }, { price: 200, qty: 1 }];
        const r = priceMarketFill({ levels: thin, touch: D(100), side: "BUY", qty: D(500), model: MODEL })!;
        expect(r.price.toString()).toBe("100");
        expect(r.slippageBps.toNumber()).toBe(0);
        expect(r.beyondBookQty.toNumber()).toBe(0);
    });

    it("inside the band needs no depth at all (ticker reference)", () => {
        const r = priceMarketFill({ levels: undefined, touch: D(100), side: "SELL", qty: D(500), model: MODEL })!;
        expect(r.price.toString()).toBe("100");
    });

    it("exactly at the band: still the touch", () => {
        const r = priceMarketFill({ levels: ASKS, touch: D(100), side: "BUY", qty: D(500), model: MODEL })!;
        expect(r.price.toString()).toBe("100");
    });

    it("above the band with no depth: null (the caller rejects)", () => {
        expect(priceMarketFill({ levels: undefined, touch: D(100), side: "BUY", qty: D(501), model: MODEL })).toBeNull();
        expect(priceMarketFill({ levels: [], touch: D(100), side: "BUY", qty: D(501), model: MODEL })).toBeNull();
    });

    it("the band's depth is skipped, then the book walks: BUY", () => {
        // 1,500: 500 band @100, 500 rest of level 1 @100, 500 @101.
        const r = priceMarketFill({ levels: ASKS, touch: D(100), side: "BUY", qty: D(1500), model: MODEL })!;
        expect(r.price.toNumber()).toBeCloseTo((1000 * 100 + 500 * 101) / 1500, 8);
        expect(r.beyondBookQty.toNumber()).toBe(0);
        expect(r.slippageBps.toNumber()).toBeCloseTo(33.3333, 3);
    });

    it("mirrors on the bid: SELL fills lower", () => {
        const r = priceMarketFill({ levels: BIDS, touch: D(99), side: "SELL", qty: D(1500), model: MODEL })!;
        expect(r.price.toNumber()).toBeCloseTo((1000 * 99 + 500 * 98) / 1500, 8);
        expect(r.slippageBps.toNumber()).toBeGreaterThan(0);
    });

    it("no jump at the band: one unit over costs almost nothing", () => {
        const at = priceMarketFill({ levels: ASKS, touch: D(100), side: "BUY", qty: D(500), model: MODEL })!;
        const over = priceMarketFill({ levels: ASKS, touch: D(100), side: "BUY", qty: D("500.01"), model: MODEL })!;
        expect(over.price.toNumber()).toBe(at.price.toNumber());
    });

    it("past the last level: linear impact from it (10 bps per band of quote, the average is half)", () => {
        // 3,500 against 3,000 of depth: 500 left, last level 102.
        // excess = 500 × 102 = $51,000 → end impact 10.2 bps → average 5.1 bps.
        const r = priceMarketFill({ levels: ASKS, touch: D(100), side: "BUY", qty: D(3500), model: MODEL })!;
        const beyond = 102 * (1 + 5.1 / 10_000);
        const expected = (1000 * 100 + 1000 * 101 + 1000 * 102 + 500 * beyond) / 3500;
        expect(r.price.toNumber()).toBeCloseTo(expected, 6);
        expect(r.beyondBookQty.toNumber()).toBe(500);
    });

    it("a book smaller than the band: the excess starts at the last level", () => {
        const thin = [{ price: 100, qty: 1 }];
        const r = priceMarketFill({ levels: thin, touch: D(100), side: "BUY", qty: D(1000), model: MODEL })!;
        // 500 band @100; 500 beyond: $50,000 → 10 bps end → 5 bps average.
        expect(r.price.toNumber()).toBeCloseTo((500 * 100 + 500 * 100 * 1.0005) / 1000, 6);
    });

    it("beyond-book impact is bounded, so a huge SELL can never price at or below zero", () => {
        const r = priceMarketFill({ levels: BIDS, touch: D(99), side: "SELL", qty: D(100_000_000), model: MODEL })!;
        expect(r.price.toNumber()).toBeGreaterThan(0);
        expect(r.price.toNumber()).toBeGreaterThanOrEqual(98 * (1 - MAX_BEYOND_BOOK_BPS / 2 / 10_000) - 1e-6);
    });

    it("a zero band means every unit walks, and zero liquidity config can't divide by zero", () => {
        const zero: FillModel = { touchBandQuote: D(0), impactBpsPerBand: D(10) };
        const r = priceMarketFill({ levels: ASKS, touch: D(100), side: "BUY", qty: D(4000), model: zero })!;
        expect(r.price.isFinite()).toBe(true);
    });

    it("deterministic: same book, same order, same price", () => {
        const a = priceMarketFill({ levels: ASKS, touch: D(100), side: "BUY", qty: D("2222.5"), model: MODEL })!;
        const b = priceMarketFill({ levels: ASKS, touch: D(100), side: "BUY", qty: D("2222.5"), model: MODEL })!;
        expect(a.price.toString()).toBe(b.price.toString());
    });

    it("worse with size: average price never improves as the order grows", () => {
        let prev = 0;
        for (let q = 100; q <= 5000; q += 100) {
            const p = priceMarketFill({ levels: ASKS, touch: D(100), side: "BUY", qty: D(q), model: MODEL })!.price.toNumber();
            expect(p).toBeGreaterThanOrEqual(prev);
            prev = p;
        }
    });
});
