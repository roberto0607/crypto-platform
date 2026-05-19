import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
    addSample,
    getSnapshot,
    getStatus,
    stopPressureAggregator,
} from "../pressureAggregator";

// stopPressureAggregator() clears all buffers — use it for test isolation.
describe("pressureAggregator", () => {
    beforeEach(() => stopPressureAggregator());
    afterEach(() => stopPressureAggregator());

    it("empty buffer returns emptyWindow with a 50/50 split", () => {
        const snap = getSnapshot("BTCUSD");
        expect(snap.emptyWindow).toBe(true);
        expect(snap.sampleCount).toBe(0);
        expect(snap.buyPct).toBe(50);
        expect(snap.sellPct).toBe(50);
        expect(snap.buyNotional).toBe(0);
        expect(snap.sellNotional).toBe(0);
        expect(snap.stale).toBe(true);
    });

    it("single buy sample returns 100/0", () => {
        addSample("BTCUSD", { ts: Date.now(), side: "buy", notional: 5000 });
        const snap = getSnapshot("BTCUSD");
        expect(snap.emptyWindow).toBe(false);
        expect(snap.buyPct).toBe(100);
        expect(snap.sellPct).toBe(0);
    });

    it("single sell sample returns 0/100", () => {
        addSample("BTCUSD", { ts: Date.now(), side: "sell", notional: 5000 });
        const snap = getSnapshot("BTCUSD");
        expect(snap.buyPct).toBe(0);
        expect(snap.sellPct).toBe(100);
    });

    it("mixed samples sum correctly and produce the correct percent", () => {
        const now = Date.now();
        addSample("BTCUSD", { ts: now, side: "buy", notional: 7500 });
        addSample("BTCUSD", { ts: now, side: "sell", notional: 2500 });
        const snap = getSnapshot("BTCUSD");
        expect(snap.buyNotional).toBe(7500);
        expect(snap.sellNotional).toBe(2500);
        expect(snap.buyPct).toBe(75);
        expect(snap.sellPct).toBe(25);
        expect(snap.sampleCount).toBe(2);
    });

    it("excludes samples older than the 5-minute window", () => {
        const now = Date.now();
        addSample("BTCUSD", { ts: now - 6 * 60_000, side: "buy", notional: 10_000 });
        addSample("BTCUSD", { ts: now, side: "sell", notional: 4000 });
        const snap = getSnapshot("BTCUSD");
        expect(snap.sampleCount).toBe(1);
        expect(snap.buyNotional).toBe(0);
        expect(snap.sellNotional).toBe(4000);
    });

    it("stale flag is false with a recent sample, true once samples age past 60s", () => {
        const now = Date.now();
        addSample("BTCUSD", { ts: now, side: "buy", notional: 1000 });
        expect(getSnapshot("BTCUSD").stale).toBe(false);

        stopPressureAggregator();
        // 90s old: still inside the 5-min window but past the 60s staleness
        // threshold — simulates 60s+ of no new samples without waiting.
        addSample("BTCUSD", { ts: now - 90_000, side: "buy", notional: 1000 });
        const snap = getSnapshot("BTCUSD");
        expect(snap.sampleCount).toBe(1);
        expect(snap.stale).toBe(true);
    });

    it("buyPct + sellPct always sum to exactly 100 (no rounding drift)", () => {
        const now = Date.now();
        // 1/3 vs 2/3 split forces rounding: round(33.33) = 33, sell derived = 67.
        addSample("BTCUSD", { ts: now, side: "buy", notional: 100 });
        addSample("BTCUSD", { ts: now, side: "sell", notional: 200 });
        const snap = getSnapshot("BTCUSD");
        expect(snap.buyPct).toBe(33);
        expect(snap.sellPct).toBe(67);
        expect(snap.buyPct + snap.sellPct).toBe(100);
    });

    it("enforces the 100k hard cap per pair", () => {
        const now = Date.now();
        for (let i = 0; i < 100_050; i++) {
            addSample("BTCUSD", { ts: now, side: "buy", notional: 1 });
        }
        const btc = getStatus().perPair.find((p) => p.pair === "BTCUSD");
        expect(btc?.sampleCount).toBe(100_000);
    });

    it("rejects malformed notionals without corrupting the buffer", () => {
        addSample("BTCUSD", { ts: Date.now(), side: "buy", notional: NaN });
        addSample("BTCUSD", { ts: Date.now(), side: "buy", notional: 0 });
        addSample("BTCUSD", { ts: Date.now(), side: "buy", notional: -100 });
        addSample("BTCUSD", { ts: Date.now(), side: "buy", notional: Infinity });
        const snap = getSnapshot("BTCUSD");
        expect(snap.sampleCount).toBe(0);
        expect(snap.emptyWindow).toBe(true);
    });

    it("normalizes BTC/USD and BTCUSD to the same buffer", () => {
        addSample("BTC/USD", { ts: Date.now(), side: "buy", notional: 1000 });
        const snap = getSnapshot("BTCUSD");
        expect(snap.sampleCount).toBe(1);
        expect(snap.pair).toBe("BTCUSD");
    });
});
