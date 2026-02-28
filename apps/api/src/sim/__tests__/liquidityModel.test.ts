import { describe, it, expect } from "vitest";
import { computeAvailableLiquidity } from "../liquidityModel";
import type { SimulationConfig } from "../simTypes";

const defaultConfig: SimulationConfig = {
    base_spread_bps: 5,
    base_slippage_bps: 2,
    impact_bps_per_10k_quote: 10,
    liquidity_quote_per_tick: 50000,
    volatility_widening_k: 0.5,
};

describe("liquidityModel — computeAvailableLiquidity", () => {
    it("volume-based < cap → returns volume-based", () => {
        // volume=1, last=50000 → volumeBased = 1 * 50000 * 0.1 = 5000 < 50000
        const result = computeAvailableLiquidity(defaultConfig, "1", "50000.00000000");
        expect(result).toBe("5000.00000000");
    });

    it("volume-based > cap → returns cap", () => {
        // volume=1000, last=50000 → volumeBased = 1000 * 50000 * 0.1 = 5,000,000 > 50000
        const result = computeAvailableLiquidity(defaultConfig, "1000", "50000.00000000");
        expect(result).toBe("50000.00000000");
    });

    it("null volume → returns cap", () => {
        const result = computeAvailableLiquidity(defaultConfig, null, "50000.00000000");
        expect(result).toBe("50000.00000000");
    });
});
