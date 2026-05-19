import { describe, it, expect } from "vitest";
import { coinbaseTradeSide, krakenTradeSide } from "../pressureAggregator";

// Guards the critical aggressor-side mapping. A silent inversion here would
// corrupt every pressure reading, so each exchange's payload shape is asserted
// directly against a representative sample event.
describe("pressure side mapping", () => {
    describe("Coinbase Advanced Trade market_trades", () => {
        it("maps 'BUY' aggressor → TradeSide 'buy'", () => {
            const trade = { product_id: "BTC-USD", price: "60000", size: "0.1", side: "BUY" };
            expect(coinbaseTradeSide(trade)).toBe("buy");
        });

        it("maps 'SELL' aggressor → TradeSide 'sell'", () => {
            const trade = { product_id: "BTC-USD", price: "60000", size: "0.1", side: "SELL" };
            expect(coinbaseTradeSide(trade)).toBe("sell");
        });

        it("returns undefined for a missing or unknown side", () => {
            const noSide = { product_id: "BTC-USD", price: "60000", size: "0.1" };
            expect(coinbaseTradeSide(noSide)).toBeUndefined();
            expect(coinbaseTradeSide({ side: "weird" })).toBeUndefined();
        });
    });

    describe("Kraken WS v2 trade channel", () => {
        // Kraken WS v2 uses a named `side` field ("buy"/"sell"), NOT the v1
        // tuple form ("b"/"s"). This codebase subscribes to v2.
        it("maps 'buy' aggressor → TradeSide 'buy'", () => {
            const trade = { symbol: "BTC/USD", price: 60000, qty: 0.1, side: "buy" };
            expect(krakenTradeSide(trade)).toBe("buy");
        });

        it("maps 'sell' aggressor → TradeSide 'sell'", () => {
            const trade = { symbol: "BTC/USD", price: 60000, qty: 0.1, side: "sell" };
            expect(krakenTradeSide(trade)).toBe("sell");
        });

        it("returns undefined for a missing or unknown side", () => {
            const noSide = { symbol: "BTC/USD", price: 60000, qty: 0.1 };
            expect(krakenTradeSide(noSide)).toBeUndefined();
            expect(krakenTradeSide({ side: "b" })).toBeUndefined();
        });
    });
});
