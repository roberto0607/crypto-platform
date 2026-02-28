import { describe, it, expect } from "vitest";
import { computeMarketExecution } from "../slippageModel";
import type { SimulationConfig } from "../simTypes";
import type { Snapshot } from "../../market/snapshotStore";

const defaultConfig: SimulationConfig = {
    base_spread_bps: 5,
    base_slippage_bps: 2,
    impact_bps_per_10k_quote: 10,
    liquidity_quote_per_tick: 50000,
    volatility_widening_k: 0.5,
};

const defaultSnapshot: Snapshot = {
    bid: null,
    ask: null,
    last: "50000.00000000",
    ts: "2025-01-01T00:00:00.000Z",
    source: "replay",
};

describe("slippageModel — computeMarketExecution", () => {
    it("is deterministic: same inputs → same output", () => {
        const results = Array.from({ length: 100 }, () =>
            computeMarketExecution(
                defaultSnapshot, "BUY", "0.1",
                defaultConfig, "100", "50100.00000000", "49900.00000000"
            )
        );
        for (const r of results) {
            expect(r).not.toBeNull();
            expect(r!.execPrice).toBe(results[0]!.execPrice);
            expect(r!.slippage_bps).toBe(results[0]!.slippage_bps);
        }
    });

    it("larger qty → larger slippage_bps", () => {
        const small = computeMarketExecution(
            defaultSnapshot, "BUY", "0.01",
            defaultConfig, "100", "50100.00000000", "49900.00000000"
        );
        const large = computeMarketExecution(
            defaultSnapshot, "BUY", "0.5",
            defaultConfig, "100", "50100.00000000", "49900.00000000"
        );
        expect(small).not.toBeNull();
        expect(large).not.toBeNull();
        expect(parseFloat(large!.slippage_bps)).toBeGreaterThan(parseFloat(small!.slippage_bps));
    });

    it("rejects when requestedNotional > availableLiquidity", () => {
        const result = computeMarketExecution(
            defaultSnapshot, "BUY", "99999",
            defaultConfig, "1", "50100.00000000", "49900.00000000"
        );
        expect(result).toBeNull();
    });

    it("BUY execPrice > SELL execPrice for same inputs", () => {
        const buy = computeMarketExecution(
            defaultSnapshot, "BUY", "0.1",
            defaultConfig, "100", "50100.00000000", "49900.00000000"
        );
        const sell = computeMarketExecution(
            defaultSnapshot, "SELL", "0.1",
            defaultConfig, "100", "50100.00000000", "49900.00000000"
        );
        expect(buy).not.toBeNull();
        expect(sell).not.toBeNull();
        expect(parseFloat(buy!.execPrice)).toBeGreaterThan(parseFloat(sell!.execPrice));
    });

    it("null candle volume → uses liquidity_quote_per_tick", () => {
        const result = computeMarketExecution(
            defaultSnapshot, "BUY", "0.1",
            defaultConfig, null, null, null
        );
        expect(result).not.toBeNull();
        expect(result!.availableLiquidityQuote).toBe("50000.00000000");
    });

    it("wide candle range → larger spread_bps_effective", () => {
        const narrow = computeMarketExecution(
            defaultSnapshot, "BUY", "0.1",
            defaultConfig, "100", "50010.00000000", "49990.00000000"
        );
        const wide = computeMarketExecution(
            defaultSnapshot, "BUY", "0.1",
            defaultConfig, "100", "51000.00000000", "49000.00000000"
        );
        expect(narrow).not.toBeNull();
        expect(wide).not.toBeNull();
        expect(parseFloat(wide!.spread_bps_effective)).toBeGreaterThan(
            parseFloat(narrow!.spread_bps_effective)
        );
    });
});
