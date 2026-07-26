/**
 * computeLiveMatchPnl.test.ts — pure-function unit tests, no DB. Mirrors the
 * shouldFireAlert/shouldTrigger convention: deterministic given inputs,
 * directly testable without a live tick or a connection.
 */

import { describe, it, expect } from "vitest";
import { computeUnrealizedRowPnl, computeLiveMatchPnl, type LivePositionRow } from "../matchService";

describe("computeUnrealizedRowPnl", () => {
    it("computes positive PnL for a long position that moved up", () => {
        expect(computeUnrealizedRowPnl("2", "50000", 51000)).toBe("2000.00000000");
    });

    it("computes negative PnL for a long position that moved down", () => {
        expect(computeUnrealizedRowPnl("2", "50000", 49000)).toBe("-2000.00000000");
    });

    it("computes positive PnL for a short position that moved down", () => {
        expect(computeUnrealizedRowPnl("-2", "50000", 49000)).toBe("2000.00000000");
    });

    it("computes negative PnL for a short position that moved up", () => {
        expect(computeUnrealizedRowPnl("-2", "50000", 51000)).toBe("-2000.00000000");
    });

    it("returns zero PnL when price is unchanged", () => {
        expect(computeUnrealizedRowPnl("5", "50000", 50000)).toBe("0.00000000");
    });

    it("accepts a string price identically to a number price", () => {
        expect(computeUnrealizedRowPnl("2", "50000", "51000")).toBe(
            computeUnrealizedRowPnl("2", "50000", 51000),
        );
    });
});

describe("computeLiveMatchPnl", () => {
    function row(overrides: Partial<LivePositionRow> = {}): LivePositionRow {
        return {
            pairId: "pair-btc",
            baseQty: "0",
            avgEntryPrice: "0",
            realizedPnlQuote: "0",
            feesPaidQuote: "0",
            ...overrides,
        };
    }

    it("returns 0 when startingCapital is not positive (avoids div-by-zero)", () => {
        expect(computeLiveMatchPnl([row()], new Map(), 0)).toBe(0);
        expect(computeLiveMatchPnl([row()], new Map(), -100)).toBe(0);
    });

    it("returns 0 for a match with no position rows", () => {
        expect(computeLiveMatchPnl([], new Map(), 50_000)).toBe(0);
    });

    it("sums realized PnL net of fees across flat (closed) rows, no price needed", () => {
        const positions = [
            row({ pairId: "pair-btc", realizedPnlQuote: "500", feesPaidQuote: "10" }),
            row({ pairId: "pair-eth", realizedPnlQuote: "-100", feesPaidQuote: "5" }),
        ];
        // (500 - 10) + (-100 - 5) = 385; 385 / 50000 * 100 = 0.77%
        expect(computeLiveMatchPnl(positions, new Map(), 50_000)).toBeCloseTo(0.77, 8);
    });

    it("adds unrealized mark-to-market for an open row using the supplied price", () => {
        const positions = [
            row({ pairId: "pair-btc", baseQty: "1", avgEntryPrice: "50000", realizedPnlQuote: "0", feesPaidQuote: "0" }),
        ];
        const prices = new Map([["pair-btc", 51000]]);
        // unrealized = 1 * (51000 - 50000) = 1000; 1000 / 50000 * 100 = 2%
        expect(computeLiveMatchPnl(positions, prices, 50_000)).toBeCloseTo(2, 8);
    });

    it("combines realized (booked) and unrealized (open) rows across multiple pairs", () => {
        const positions = [
            row({ pairId: "pair-btc", baseQty: "1", avgEntryPrice: "50000", realizedPnlQuote: "0", feesPaidQuote: "0" }),
            row({ pairId: "pair-eth", baseQty: "0", avgEntryPrice: "0", realizedPnlQuote: "250", feesPaidQuote: "0" }),
        ];
        const prices = new Map([["pair-btc", 51000]]);
        // unrealized 1000 + realized 250 = 1250; 1250 / 50000 * 100 = 2.5%
        expect(computeLiveMatchPnl(positions, prices, 50_000)).toBeCloseTo(2.5, 8);
    });

    it("falls back to realized-only for an open row with no price available (best-effort, not a throw)", () => {
        const positions = [
            row({ pairId: "pair-btc", baseQty: "1", avgEntryPrice: "50000", realizedPnlQuote: "0", feesPaidQuote: "0" }),
            row({ pairId: "pair-eth", baseQty: "0", avgEntryPrice: "0", realizedPnlQuote: "300", feesPaidQuote: "0" }),
        ];
        // No price supplied for pair-btc at all -- its unrealized leg is skipped.
        expect(computeLiveMatchPnl(positions, new Map(), 50_000)).toBeCloseTo(0.6, 8);
    });

    it("skips an open row's price when it is non-finite (NaN/Infinity guarded)", () => {
        const positions = [
            row({ pairId: "pair-btc", baseQty: "1", avgEntryPrice: "50000", realizedPnlQuote: "100", feesPaidQuote: "0" }),
        ];
        const prices = new Map([["pair-btc", NaN]]);
        expect(computeLiveMatchPnl(positions, prices, 50_000)).toBeCloseTo(0.2, 8);
    });

    it("handles a short position's unrealized PnL within the aggregate", () => {
        const positions = [
            row({ pairId: "pair-btc", baseQty: "-2", avgEntryPrice: "50000", realizedPnlQuote: "0", feesPaidQuote: "0" }),
        ];
        const prices = new Map([["pair-btc", 49000]]);
        // unrealized = -2 * (49000 - 50000) = 2000; 2000 / 50000 * 100 = 4%
        expect(computeLiveMatchPnl(positions, prices, 50_000)).toBeCloseTo(4, 8);
    });
});
