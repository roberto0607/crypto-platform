import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import client from "prom-client";

// ── Fake socket ──
const sockets = vi.hoisted(() => [] as any[]);
vi.mock("ws", async () => {
    const { EventEmitter } = await import("node:events");
    class FakeWebSocket extends EventEmitter {
        static CONNECTING = 0;
        static OPEN = 1;
        static CLOSING = 2;
        static CLOSED = 3;
        readyState = 0;
        sent: string[] = [];
        terminate = vi.fn(() => { this.readyState = 3; });
        close = vi.fn(() => { this.readyState = 2; });
        pause = vi.fn();
        resume = vi.fn();
        constructor(public url: string) {
            super();
            sockets.push(this);
        }
        send(m: string) { this.sent.push(m); }
    }
    return { default: FakeWebSocket };
});

const PRODUCTS = vi.hoisted(() => ({ list: ["BTC-USD", "ETH-USD", "SOL-USD"] }));
vi.mock("../../market/symbolRegistry.js", () => ({
    loadActiveSymbols: vi.fn(async () =>
        PRODUCTS.list.map((p) => ({ ourSymbol: p.replace("-", "/"), wsSymbol: p, restSymbol: p, pairId: `pair-${p}` })),
    ),
}));
vi.mock("../../market/candleAggregator.js", () => ({ aggregateTick: vi.fn() }));
vi.mock("../../services/pressureAggregator.js", () => ({ coinbaseTradeSide: () => "buy", addSample: vi.fn() }));
vi.mock("../../events/eventBus.js", () => ({ publish: vi.fn() }));
const logger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock("../../observability/logContext.js", () => ({ logger }));

import { config } from "../../config";
import {
    startCoinbaseFeed,
    stopCoinbaseFeed,
    getCoinbaseWsHealth,
    isCoinbaseStaleFor,
    __debugFaultCoinbaseSockets,
    __resetCoinbaseWsForTest,
} from "../coinbaseWs";
import { getFeedHealthSnapshot, recordFeedTick, __resetFeedHealthForTest } from "../../observability/feedHealth";

const SYMBOLS = ["BTC/USD", "ETH/USD", "SOL/USD"];
const saved = {
    hbKill: config.feedCoinbaseHeartbeatKillEnabled,
    symKill: config.feedCoinbaseSymbolKillEnabled,
};

const msg = (o: unknown) => Buffer.from(JSON.stringify(o));
let hbCounter = 0;
let tradeIdSeq = 1_000_000;
const heartbeat = () => msg({ channel: "heartbeats", events: [{ heartbeat_counter: ++hbCounter }] });
const trade = (product: string, type: "update" | "snapshot" = "update") =>
    msg({
        channel: "market_trades",
        events: [{ type, trades: [{ trade_id: String(++tradeIdSeq), product_id: product, price: "100", size: "1", side: "BUY", time: new Date().toISOString() }] }],
    });

const current = () => sockets[sockets.length - 1] as EventEmitter & Record<string, any>;
const reconnectsOf = (cause?: string) =>
    getFeedHealthSnapshot().reconnects.coinbase!.recent.filter((r) => !cause || r.cause === cause);
const logged = (event: string) => logger.warn.mock.calls.filter((c) => c[1] === event).map((c) => c[0]);

async function open(socket = current()) {
    socket.readyState = 1;
    socket.emit("open");
    await vi.advanceTimersByTimeAsync(0);
}

/**
 * Advance `seconds`, one second at a time, delivering what a live socket sends
 * each second: a heartbeat, a Coinbase trade per `trades` product, and a
 * Kraken trade (as recorded in feedHealth) per `kraken` symbol.
 */
async function pump(seconds: number, f: { heartbeat?: boolean; trades?: string[]; kraken?: string[] } = {}) {
    for (let i = 0; i < seconds; i++) {
        const s = current();
        if (s.readyState === 1 && s.listenerCount("message") > 0) {
            if (f.heartbeat ?? true) s.emit("message", heartbeat());
            for (const p of f.trades ?? PRODUCTS.list) s.emit("message", trade(p));
        }
        for (const k of f.kraken ?? []) recordFeedTick("kraken_trade", k);
        await vi.advanceTimersByTimeAsync(1_000);
    }
}

describe("coinbaseWs watchdogs", () => {
    beforeEach(async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_700_000_000_000);
        vi.spyOn(Math, "random").mockReturnValue(0.5); // no jitter → exact backoff delays
        PRODUCTS.list = ["BTC-USD", "ETH-USD", "SOL-USD"];
        config.feedCoinbaseHeartbeatKillEnabled = true;
        config.feedCoinbaseSymbolKillEnabled = false;
        __resetCoinbaseWsForTest();
        __resetFeedHealthForTest();
        logger.warn.mockClear();
        logger.info.mockClear();
        sockets.length = 0;

        startCoinbaseFeed();
        await vi.advanceTimersByTimeAsync(0); // reconcileBatches loads symbols → connects batch 0
        await open();
        await pump(3); // healthy start: heartbeats + a trade on every product
    });

    afterEach(() => {
        stopCoinbaseFeed();
        config.feedCoinbaseHeartbeatKillEnabled = saved.hbKill;
        config.feedCoinbaseSymbolKillEnabled = saved.symKill;
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it("subscribes market_trades and heartbeats on open, and reports health on /health's coinbaseWs object", () => {
        expect(current().sent.map((s: string) => JSON.parse(s))).toEqual([
            { type: "subscribe", product_ids: PRODUCTS.list, channel: "market_trades" },
            { type: "subscribe", channel: "heartbeats" },
        ]);
        const h = getCoinbaseWsHealth();
        expect(h).toMatchObject({
            connected: true,
            status: "connected",
            heartbeatKillEnabled: true,
            symbolKillEnabled: false,
            batches: 1,
        });
        expect(h.heartbeatAgeMs).toBeLessThanOrEqual(1_000);
        expect(Object.keys(h.symbols)).toEqual(SYMBOLS);
        for (const s of SYMBOLS) expect(h.symbols[s]).toMatchObject({ status: "ok" });
    });

    it("heartbeat silence (stalled socket) → terminate(), not close(), and exactly one reconnect", async () => {
        const first = current();
        expect(__debugFaultCoinbaseSockets("stall")).toBe(1);
        await pump(6, { heartbeat: false, trades: [] });

        expect(first.terminate).toHaveBeenCalledTimes(1);
        expect(first.close).not.toHaveBeenCalled();
        expect(reconnectsOf()).toEqual([
            expect.objectContaining({ cause: "watchdog_heartbeat_stale", detail: expect.stringMatching(/^batch 0: no heartbeat for \d+ms$/) }),
        ]);
        expect(logged("feed_watchdog_kill")).toEqual([
            expect.objectContaining({ exchange: "coinbase", cause: "watchdog_heartbeat_stale", symbol: "_connection", thresholdMs: 5_000 }),
        ]);
        expect(getCoinbaseWsHealth().status).toBe("disconnected");

        // The dead socket's late events must not schedule a second reconnect.
        first.emit("close", 1006, Buffer.from(""));
        first.emit("error", new Error("late"));
        await vi.advanceTimersByTimeAsync(1_000); // backoff attempt 1 = 1s
        expect(sockets).toHaveLength(2);
        expect(reconnectsOf()).toHaveLength(1);

        await open();
        await pump(3);
        expect(getCoinbaseWsHealth().status).toBe("connected");
        expect(sockets).toHaveLength(2);
    });

    it("heartbeat silence with FEED_COINBASE_HEARTBEAT_KILL_ENABLED=false → would_kill only", async () => {
        config.feedCoinbaseHeartbeatKillEnabled = false;
        await pump(8, { heartbeat: false });
        expect(current().terminate).not.toHaveBeenCalled();
        expect(reconnectsOf()).toEqual([]);
        expect(logged("feed_watchdog_would_kill")).toEqual([
            expect.objectContaining({ exchange: "coinbase", cause: "watchdog_heartbeat_stale" }),
        ]);
        expect(getCoinbaseWsHealth().status).toBe("stale");
    });

    it("SOL silent on Coinbase while Kraken trades SOL → feed_watchdog_would_kill (exchange=coinbase) once, socket kept", async () => {
        await pump(70, { trades: ["BTC-USD", "ETH-USD"], kraken: ["SOL/USD"] });

        expect(current().terminate).not.toHaveBeenCalled();
        expect(sockets).toHaveLength(1);
        expect(reconnectsOf()).toEqual([]);
        expect(logged("feed_watchdog_would_kill")).toEqual([
            expect.objectContaining({ exchange: "coinbase", cause: "watchdog_cross_check_stale", symbol: "SOL/USD", thresholdMs: 60_000 }),
        ]);
        expect(logged("feed_watchdog_would_kill")[0].silentMs).toBeGreaterThan(60_000);

        const h = getCoinbaseWsHealth();
        expect(h.symbols["SOL/USD"]!.status).toBe("stale");
        expect(h.symbols["BTC/USD"]!.status).toBe("ok");
        expect(h.status).toBe("stale");

        const metrics = [
            await client.register.getSingleMetricAsString("tradr_feed_watchdog_trips_total"),
            await client.register.getSingleMetricAsString("tradr_feed_symbol_stale"),
        ].join("\n");
        expect(metrics).toContain(
            'tradr_feed_watchdog_trips_total{exchange="coinbase",cause="watchdog_cross_check_stale",symbol="SOL/USD",action="would_kill"} 1',
        );
        expect(metrics).toContain('tradr_feed_symbol_stale{exchange="coinbase",channel="trades",symbol="SOL/USD"} 1');
        expect(metrics).toContain('tradr_feed_symbol_stale{exchange="coinbase",channel="trades",symbol="BTC/USD"} 0');

        // SOL trades again → health and gauge clear.
        await pump(1);
        expect(getCoinbaseWsHealth().symbols["SOL/USD"]!.status).toBe("ok");
        expect(await client.register.getSingleMetricAsString("tradr_feed_symbol_stale"))
            .toContain('tradr_feed_symbol_stale{exchange="coinbase",channel="trades",symbol="SOL/USD"} 0');
    });

    it("SOL quiet on BOTH exchanges is a lull, not a dead feed → no trip", async () => {
        await pump(90, { trades: ["BTC-USD", "ETH-USD"], kraken: ["BTC/USD"] });
        expect(logged("feed_watchdog_would_kill")).toEqual([]);
        const h = getCoinbaseWsHealth();
        expect(h.symbols["SOL/USD"]!.status).toBe("quiet");
        expect(h.status).toBe("connected");
    });

    it("Kraken trades from before Coinbase went silent don't count", async () => {
        recordFeedTick("kraken_trade", "SOL/USD"); // before SOL's last Coinbase trade
        await pump(1);
        await pump(90, { trades: ["BTC-USD", "ETH-USD"] });
        expect(logged("feed_watchdog_would_kill")).toEqual([]);
    });

    it("cross-check with FEED_COINBASE_SYMBOL_KILL_ENABLED → terminate + reconnect", async () => {
        config.feedCoinbaseSymbolKillEnabled = true;
        const first = current();
        await pump(59, { trades: ["BTC-USD", "ETH-USD"], kraken: ["SOL/USD"] });
        expect(first.terminate).not.toHaveBeenCalled(); // 60s threshold not crossed yet
        await pump(3, { trades: ["BTC-USD", "ETH-USD"], kraken: ["SOL/USD"] });

        expect(first.terminate).toHaveBeenCalledTimes(1);
        expect(reconnectsOf()).toEqual([
            expect.objectContaining({
                cause: "watchdog_cross_check_stale",
                detail: expect.stringMatching(/^batch 0: no trades for SOL\/USD for \d+ms while Kraken traded it \d+ms ago$/),
            }),
        ]);
        expect(logged("feed_watchdog_kill")).toEqual([expect.objectContaining({ exchange: "coinbase", symbol: "SOL/USD" })]);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(sockets).toHaveLength(2);
    });

    it("the subscribe-time snapshot is not liveness: a symbol that only ever got its snapshot still trips", async () => {
        current().emit("close", 1006, Buffer.from(""));
        await vi.advanceTimersByTimeAsync(1_000);
        await open();
        current().emit("message", trade("SOL-USD", "snapshot"));
        await pump(70, { trades: ["BTC-USD", "ETH-USD"], kraken: ["SOL/USD"] });
        expect(logged("feed_watchdog_would_kill")).toEqual([
            expect.objectContaining({ symbol: "SOL/USD", cause: "watchdog_cross_check_stale" }),
        ]);
        expect(isCoinbaseStaleFor("SOL/USD")).toBe(true);
    });

    it("isCoinbaseStaleFor is per-symbol: BTC trading keeps BTC fresh while silent SOL goes stale after 15s", async () => {
        await pump(14, { trades: ["BTC-USD"] });
        expect(isCoinbaseStaleFor("SOL/USD")).toBe(false);
        await pump(3, { trades: ["BTC-USD"] });
        expect(isCoinbaseStaleFor("SOL/USD")).toBe(true);
        expect(isCoinbaseStaleFor("BTC/USD")).toBe(false);
    });

    it("backs off exponentially across connect-then-drop cycles instead of resetting on open", async () => {
        const delays: number[] = [];
        for (let i = 0; i < 5; i++) {
            current().emit("close", 1006, Buffer.from(""));
            const scheduled = logger.info.mock.calls.filter((c) => c[1] === "coinbase_ws_reconnect_scheduled");
            const delay = scheduled[scheduled.length - 1]![0].delay as number;
            delays.push(delay);
            await vi.advanceTimersByTimeAsync(delay);
            await open();
            await pump(2); // brief data, then it drops again
        }
        expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000]);
        expect(reconnectsOf("socket_close")).toHaveLength(5);
    });

    it("resets the backoff only after 60s of live trades", async () => {
        current().emit("close", 1006, Buffer.from(""));
        await vi.advanceTimersByTimeAsync(1_000);
        await open();
        await pump(61);
        current().emit("close", 1006, Buffer.from(""));
        const scheduled = logger.info.mock.calls.filter((c) => c[1] === "coinbase_ws_reconnect_scheduled");
        expect(scheduled.map((c) => c[0].delay)).toEqual([1_000, 1_000]);
    });

    it("an error event terminates the socket instead of waiting on a close handshake", async () => {
        const first = current();
        first.emit("error", new Error("ECONNRESET"));
        expect(first.terminate).toHaveBeenCalledTimes(1);
        expect(first.close).not.toHaveBeenCalled();
        expect(reconnectsOf()).toEqual([expect.objectContaining({ cause: "socket_error", detail: "batch 0: ECONNRESET" })]);
        expect(getCoinbaseWsHealth().status).toBe("disconnected");
        expect(getCoinbaseWsHealth().symbols["BTC/USD"]!.status).toBe("disconnected");
    });

    it("stop tears sockets down without scheduling a reconnect", async () => {
        const first = current();
        stopCoinbaseFeed();
        expect(first.terminate).toHaveBeenCalledTimes(1);
        first.emit("close", 1000, Buffer.from(""));
        await vi.advanceTimersByTimeAsync(120_000);
        expect(sockets).toHaveLength(1);
        expect(reconnectsOf()).toEqual([]);
    });
});
