/**
 * priceCollar.test.ts — collar reference freshness and band boundaries.
 * Pure: drives the in-process Kraken book Map directly, no DB.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { getCollarReference, collarBand, isWithinCollar } from "../priceCollar";
import { bookSnapshots } from "../../market/orderFlowFeatures";
import { D } from "../../utils/decimal";

const PAIR = "pair-1";
const NOW = 1_800_000_000_000;

function setBook(bids: number[], asks: number[], ageMs = 0) {
    bookSnapshots.set(PAIR, {
        bids: bids.map((price) => ({ price, qty: 1 })),
        asks: asks.map((price) => ({ price, qty: 1 })),
        ts: NOW - ageMs,
    });
}

beforeEach(() => {
    bookSnapshots.clear();
});

describe("getCollarReference", () => {
    it("returns the Kraken best bid/ask from a fresh book", () => {
        setBook([100, 99], [101, 102], 1_000);
        const ref = getCollarReference(PAIR, NOW, 5_000)!;
        expect(ref.bestBid.toString()).toBe("100");
        expect(ref.bestAsk.toString()).toBe("101");
        expect(ref.ageMs).toBe(1_000);
    });

    it("accepts a book exactly maxAgeMs old and rejects one 1ms older", () => {
        setBook([100], [101], 5_000);
        expect(getCollarReference(PAIR, NOW, 5_000)).not.toBeNull();
        setBook([100], [101], 5_001);
        expect(getCollarReference(PAIR, NOW, 5_000)).toBeNull();
    });

    it("returns null with no book, an empty side, or a crossed book", () => {
        expect(getCollarReference(PAIR, NOW, 5_000)).toBeNull();
        setBook([], [101]);
        expect(getCollarReference(PAIR, NOW, 5_000)).toBeNull();
        setBook([100], []);
        expect(getCollarReference(PAIR, NOW, 5_000)).toBeNull();
        setBook([102], [101]);
        expect(getCollarReference(PAIR, NOW, 5_000)).toBeNull();
    });

    it("accepts a locked book (bid == ask)", () => {
        setBook([100], [100]);
        expect(getCollarReference(PAIR, NOW, 5_000)).not.toBeNull();
    });
});

describe("collarBand — at the Kraken touch or better, at most 25bps better", () => {
    const ref = { bestBid: D("80000"), bestAsk: D("80010"), ageMs: 0, source: "book" as const };

    it("taker BUY: capped at Kraken's best ask, down to 25bps below it, inclusive", () => {
        const band = collarBand(ref, "BUY", 25);
        // 80010 × 0.0025 = 200.025
        expect(band.min.toString()).toBe("79809.975");
        expect(band.max.toString()).toBe("80010");
        expect(isWithinCollar("79809.975", band)).toBe(true);
        expect(isWithinCollar("80010", band)).toBe(true);
        expect(isWithinCollar("80005", band)).toBe(true);
    });

    it("taker BUY skips any ask above the touch and a stale-low ask", () => {
        const band = collarBand(ref, "BUY", 25);
        expect(isWithinCollar("80010.01", band)).toBe(false); // above the touch — system fill is cheaper
        expect(isWithinCollar("79809.97", band)).toBe(false); // stale-low ask (prod fill #1 shape)
    });

    it("taker SELL: capped at Kraken's best bid, up to 25bps above it, inclusive", () => {
        const band = collarBand(ref, "SELL", 25);
        // 80000 × 0.0025 = 200
        expect(band.min.toString()).toBe("80000");
        expect(band.max.toString()).toBe("80200");
        expect(isWithinCollar("80000", band)).toBe(true);
        expect(isWithinCollar("80200", band)).toBe(true);
        expect(isWithinCollar("79999.99", band)).toBe(false); // below the touch
        expect(isWithinCollar("80200.01", band)).toBe(false); // stale-high bid
    });
});
