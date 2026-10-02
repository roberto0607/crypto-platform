import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import client from "prom-client";
import {
    recordFeedTick,
    recordFeedReconnect,
    getFeedHealthSnapshot,
    getSymbolFeedHealth,
    startEventLoopMonitor,
    stopEventLoopMonitor,
    __resetFeedHealthForTest,
    __rollEventLoopWindowForTest,
} from "../feedHealth";

describe("feedHealth", () => {
    beforeEach(() => {
        __resetFeedHealthForTest();
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(1_000_000);
    });
    afterEach(() => {
        vi.useRealTimers();
        stopEventLoopMonitor();
    });

    it("tracks last-tick age and exchange lag per feed per symbol", () => {
        recordFeedTick("coinbase_trade", "BTC/USD", 1_000_000 - 250);
        recordFeedTick("kraken_ticker", "BTC/USD");
        vi.setSystemTime(1_004_000);

        const h = getSymbolFeedHealth("BTC/USD");
        expect(h.coinbase_trade).toEqual({ ageMs: 4_000, exchangeLagMs: 250, count: 1 });
        expect(h.kraken_ticker).toEqual({ ageMs: 4_000, exchangeLagMs: null, count: 1 });
        expect(h.kraken_trade).toBeNull();
    });

    it("lists a single permanently-stale symbol even while the feed overall is fresh", () => {
        recordFeedTick("kraken_ticker", "SOL/USD");
        vi.setSystemTime(1_045_000);
        recordFeedTick("kraken_ticker", "BTC/USD");

        const snap = getFeedHealthSnapshot();
        expect(snap.feeds.kraken_ticker!.newestAgeMs).toBe(0);
        expect(snap.feeds.kraken_ticker!.staleSymbols).toEqual([{ symbol: "SOL/USD", ageMs: 45_000 }]);
    });

    it("counts reconnects with cause and close code, keeping the 10 most recent", () => {
        for (let i = 0; i < 12; i++) recordFeedReconnect("kraken", "socket_close", { closeCode: 1006 });
        recordFeedReconnect("coinbase", "watchdog_stale", { detail: "no ticker for 31000ms" });

        const snap = getFeedHealthSnapshot();
        expect(snap.reconnects.kraken!.total).toBe(12);
        expect(snap.reconnects.kraken!.recent).toHaveLength(10);
        expect(snap.reconnects.coinbase!.recent[0]).toMatchObject({ cause: "watchdog_stale", closeCode: null, detail: "no ticker for 31000ms" });
    });

    it("exports Prometheus series for tick age, reconnects and event-loop lag", async () => {
        recordFeedTick("coinbase_trade", "ETH/USD");
        recordFeedReconnect("kraken", "watchdog_stale");
        startEventLoopMonitor();
        __rollEventLoopWindowForTest();
        vi.setSystemTime(1_002_000);

        const text = await client.register.metrics();
        expect(text).toContain('tradr_feed_last_tick_age_seconds{feed="coinbase_trade",symbol="ETH/USD"} 2');
        expect(text).toContain('tradr_feed_ws_reconnects_total{exchange="kraken",cause="watchdog_stale"} 1');
        expect(text).toMatch(/tradr_event_loop_lag_ms\{stat="p99"\} [\d.]+/);
        expect(getFeedHealthSnapshot().eventLoop.monitoring).toBe(true);
    });
});
