/**
 * fillPriceAudit.test.ts — the audit helper, plus the 2026-10-01 BTC/USD
 * system-fill reproductions rewritten for B1.
 *
 * Before B1 the system-fill remainder of a MARKET order was priced off
 * snapshot.last plus a synthetic spread/slippage (computeMarketExecution) and,
 * when the Kraken ticker was >10s old, off trading_pairs.last_price stamped as
 * fresh. These tests used to pin that; they now pin the replacement: the fill
 * is the real Kraken touch, and last_price is never a pricing source. The
 * end-to-end behaviour (book / ticker / reject) is in marketPricing.test.ts.
 * (Both prod bad fills turned out to be MM-quote sweeps, fixed by #188 —
 * see marketCollar.test.ts.)
 */
import { describe, it, expect } from "vitest";
import { buildFillPriceAudit } from "../fillPriceAudit";
import { computeMarketExecution } from "../../sim/slippageModel";
import { getMarketReference, systemFillPrice } from "../priceCollar";
import { D } from "../../utils/decimal";
import type { Snapshot } from "../../market/snapshotStore";
import type { SimulationConfig } from "../../sim/simTypes";

const NOW = Date.parse("2026-10-01T18:38:00.000Z");

// migration 021 defaults (what prod pairs without an override use)
const simConfig: SimulationConfig = {
    base_spread_bps: 5,
    base_slippage_bps: 2,
    impact_bps_per_10k_quote: 10,
    liquidity_quote_per_tick: 50000,
    volatility_widening_k: 0.5,
};

function book(bestBid: number, bestAsk: number, ageMs = 200) {
    return { bids: [{ price: bestBid }], asks: [{ price: bestAsk }], ts: NOW - ageMs };
}

describe("buildFillPriceAudit", () => {
    it("computes signed deviation vs the displayed touch (positive = worse for the user)", () => {
        const snapshot: Snapshot = { bid: "100", ask: "101", last: "100.5", ts: new Date(NOW - 3_000).toISOString(), source: "live" };
        const buy = buildFillPriceAudit({
            side: "BUY", snapshot, reference: null, now: NOW,
            fills: [{ price: "102", qty: "1", is_system_fill: true }],
            book: book(100, 100),
        });
        expect(buy.deviationBps).toBe(200);
        expect(buy.offBook).toBe("worse");
        expect(buy.snapshotTsAgeMs).toBe(3_000);
        expect(buy.bookAgeMs).toBe(200);

        const sell = buildFillPriceAudit({
            side: "SELL", snapshot, reference: null, now: NOW,
            fills: [{ price: "102", qty: "1", is_system_fill: true }],
            book: book(100, 100),
        });
        expect(sell.deviationBps).toBe(-200);
        expect(sell.offBook).toBe("better");
    });

    it("qty-weights the average across internal-book and system fills", () => {
        const snapshot: Snapshot = { bid: null, ask: null, last: "100", ts: new Date(NOW).toISOString(), source: "live" };
        const a = buildFillPriceAudit({
            side: "BUY", snapshot, reference: null, now: NOW,
            fills: [{ price: "99", qty: "3", is_system_fill: false }, { price: "103", qty: "1", is_system_fill: true }],
            book: book(99.9, 100),
        });
        expect(a.avgFillPrice).toBe(100);
        expect(a.offBook).toBeNull();
        expect(a.fills.map((f) => f.system)).toEqual([false, true]);
    });

    it("tolerates a missing book (pair not on Kraken / no snapshot yet)", () => {
        const snapshot: Snapshot = { bid: null, ask: null, last: "1", ts: "not-a-date", source: "fallback" };
        const a = buildFillPriceAudit({ side: "BUY", snapshot, reference: null, fills: [{ price: "1", qty: "1", is_system_fill: true }], book: undefined, now: NOW });
        expect(a).toMatchObject({ bookBestAsk: null, bookAgeMs: null, deviationBps: null, offBook: null, snapshotTsAgeMs: null });
    });

    it("records which reference priced the fill", () => {
        const snapshot: Snapshot = { bid: "100", ask: "101", last: "100.5", ts: new Date(NOW).toISOString(), source: "live" };
        const a = buildFillPriceAudit({
            side: "BUY", snapshot, now: NOW,
            reference: { bestBid: D("100"), bestAsk: D("101"), ageMs: 1_200, source: "ticker" },
            fills: [{ price: "101", qty: "1", is_system_fill: true }],
            book: book(100, 101),
        });
        expect(a).toMatchObject({ referenceSource: "ticker", referenceBid: "100", referenceAsk: "101", referenceAgeMs: 1_200, deviationBps: 0 });
    });
});

describe("system-fill pricing after B1", () => {
    it("a system fill is the real Kraken ask — 0bps from the touch, where the old model added ~+8bps", () => {
        const ref = { bestBid: D("84630.4"), bestAsk: D("84630.5"), ageMs: 200, source: "book" as const };
        const fill = systemFillPrice(ref, "BUY").toString();
        expect(fill).toBe("84630.5");
        expect(systemFillPrice(ref, "SELL").toString()).toBe("84630.4");

        const snapshot: Snapshot = { bid: "84630.4", ask: "84630.5", last: "84630.5", ts: new Date(NOW - 1_000).toISOString(), source: "live" };
        const audit = buildFillPriceAudit({
            side: "BUY", snapshot, reference: ref, now: NOW,
            fills: [{ price: fill, qty: "0.1", is_system_fill: true }],
            book: book(84630.4, 84630.5),
        });
        expect(audit.deviationBps).toBe(0);
        expect(audit.offBook).toBeNull();

        // For contrast, the pre-B1 model on the same inputs (still used, but only
        // to price solo replay sessions off historical candles):
        const old = Number(computeMarketExecution(snapshot, "BUY", "0.1", simConfig, "50", "84660", "84600")!.execPrice);
        expect((old - 84630.5) / 84630.5 * 10_000).toBeGreaterThan(7);
    });

    it("trading_pairs.last_price is never a reference: no Kraken book and no ticker → null (the caller rejects)", async () => {
        // The old fallback priced a fill off a stale last_price stamped ts=now.
        // getMarketReference has no last_price input at all.
        expect(await getMarketReference("no-such-pair", "NOPE/USD", NOW)).toBeNull();
    });
});
