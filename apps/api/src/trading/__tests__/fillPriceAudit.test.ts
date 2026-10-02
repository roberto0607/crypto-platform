/**
 * fillPriceAudit.test.ts — the audit helper, plus characterization tests of
 * the SYSTEM-fill price model (computeMarketExecution, migration-021 default
 * sim config).
 *
 * NOT the 2026-10-01 prod fills: prod trades show both bad BTC/USD fills
 * (84818.68 and 84699.32) had is_system_fill=false with maker
 * mmbot@system.local — they were sweeps of stale market-maker quotes, so
 * neither went through this model. Their regression test lands with the
 * MM-quote / collar fixes. These cases document what the system-fill path
 * can do on its own: it prices off snapshot.last + a synthetic spread and
 * never consults the displayed Kraken book or a staleness bound. They assert
 * CURRENT behavior and must be rewritten when fills move to best bid/ask.
 */
import { describe, it, expect } from "vitest";
import { buildFillPriceAudit } from "../fillPriceAudit";
import { computeMarketExecution } from "../../sim/slippageModel";
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
            side: "BUY", snapshot, simExecPrice: "102", now: NOW,
            fills: [{ price: "102", qty: "1", is_system_fill: true }],
            book: book(100, 100),
        });
        expect(buy.deviationBps).toBe(200);
        expect(buy.offBook).toBe("worse");
        expect(buy.snapshotTsAgeMs).toBe(3_000);
        expect(buy.bookAgeMs).toBe(200);

        const sell = buildFillPriceAudit({
            side: "SELL", snapshot, simExecPrice: "102", now: NOW,
            fills: [{ price: "102", qty: "1", is_system_fill: true }],
            book: book(100, 100),
        });
        expect(sell.deviationBps).toBe(-200);
        expect(sell.offBook).toBe("better");
    });

    it("qty-weights the average across internal-book and system fills", () => {
        const snapshot: Snapshot = { bid: null, ask: null, last: "100", ts: new Date(NOW).toISOString(), source: "live" };
        const a = buildFillPriceAudit({
            side: "BUY", snapshot, simExecPrice: null, now: NOW,
            fills: [{ price: "99", qty: "3", is_system_fill: false }, { price: "103", qty: "1", is_system_fill: true }],
            book: book(99.9, 100),
        });
        expect(a.avgFillPrice).toBe(100);
        expect(a.offBook).toBeNull();
        expect(a.fills.map((f) => f.system)).toEqual([false, true]);
    });

    it("tolerates a missing book (pair not on Kraken / no snapshot yet)", () => {
        const snapshot: Snapshot = { bid: null, ask: null, last: "1", ts: "not-a-date", source: "fallback" };
        const a = buildFillPriceAudit({ side: "BUY", snapshot, simExecPrice: "1", fills: [{ price: "1", qty: "1", is_system_fill: true }], book: undefined, now: NOW });
        expect(a).toMatchObject({ bookBestAsk: null, bookAgeMs: null, deviationBps: null, offBook: null, snapshotTsAgeMs: null });
    });
});

describe("system-fill price model (characterization, not the prod fills)", () => {
    it("with a fresh price, a system-filled BUY lands ~8bps above the real ask: last + synthetic spread/slippage", () => {
        // Kraken last ≈ the touch.
        const snapshot: Snapshot = { bid: "84630.4", ask: "84630.5", last: "84630.5", ts: new Date(NOW - 1_000).toISOString(), source: "live" };
        // A ~$60 1-minute range — ordinary BTC volatility.
        const sim = computeMarketExecution(snapshot, "BUY", "0.1", simConfig, "50", "84660", "84600")!;
        const fill = Number(sim.execPrice);

        // Lands ~$65–75 above the ask purely from the model: half of (5 + 0.5×7bps) spread + 2bps
        // base slippage + ~1.7bps impact. The real ask (snapshot.ask) is never read.
        expect(fill - 84630.5).toBeGreaterThan(60);
        expect(fill - 84630.5).toBeLessThan(75);

        const audit = buildFillPriceAudit({
            side: "BUY", snapshot, simExecPrice: sim.execPrice, now: NOW,
            fills: [{ price: sim.execPrice, qty: "0.1", is_system_fill: true }],
            book: book(84630.4, 84630.5),
        });
        expect(audit.deviationBps).toBeGreaterThan(7);
        expect(audit.deviationBps).toBeLessThan(9);
    });

    it("with a stale fallback snapshot, a system-filled BUY can land far below the real ask", () => {
        // Kraken ticker snapshot >10s old → resolveSnapshot falls back to trading_pairs.last_price,
        // stamped ts = now (so it LOOKS fresh) with no staleness bound. Here last_price is a
        // few-minutes-old 84,759 while the market has moved to an ask of ~85,175.
        const fallback: Snapshot = { bid: null, ask: null, last: "84759", ts: new Date(NOW).toISOString(), source: "fallback" };
        const sim = computeMarketExecution(fallback, "BUY", "0.1", simConfig, "50", "84790", "84730")!;
        const fill = Number(sim.execPrice);

        expect(fill).toBeGreaterThan(84_800);
        expect(fill).toBeLessThan(84_840);

        const audit = buildFillPriceAudit({
            side: "BUY", snapshot: fallback, simExecPrice: sim.execPrice, now: NOW,
            fills: [{ price: sim.execPrice, qty: "0.1", is_system_fill: true }],
            book: book(85150, 85175),
        });
        expect(audit.snapshotSource).toBe("fallback");
        expect(audit.snapshotTsAgeMs).toBe(0); // the masquerade: fallback reads as 0ms old
        expect(audit.offBook).toBe("better");
        expect(audit.deviationBps!).toBeLessThan(-40);
    });

    it("a system-filled BUY never lands below a fresh snapshot.last — a 'better than ask' fill means stale input or an internal resting order", () => {
        const snapshot: Snapshot = { bid: null, ask: null, last: "85175", ts: new Date(NOW).toISOString(), source: "live" };
        const sim = computeMarketExecution(snapshot, "BUY", "0.1", simConfig, "50", "85200", "85150")!;
        expect(Number(sim.execPrice)).toBeGreaterThan(85175);
    });
});
