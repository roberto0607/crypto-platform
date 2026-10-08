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

const SYMBOLS = ["BTC/USD", "ETH/USD", "SOL/USD"];
vi.mock("../symbolRegistry.js", () => ({
    loadActiveSymbols: vi.fn(async () =>
        ["BTC/USD", "ETH/USD", "SOL/USD"].map((s) => ({ ourSymbol: s, wsSymbol: s, restSymbol: s, pairId: `pair-${s}` })),
    ),
}));
vi.mock("../candleAggregator.js", () => ({ aggregateTick: vi.fn(), flushDueCandles: vi.fn(async () => {}) }));
vi.mock("../candleBackfill.js", () => ({ runBackfill: vi.fn(async () => ({})) }));
vi.mock("../formingCandle.js", () => ({ seedOpenCandlesFromKrakenRest: vi.fn(async () => 0) }));
vi.mock("../snapshotStore", () => ({ setSnapshot: vi.fn(async () => {}) }));
vi.mock("../../events/eventBus", () => ({ publish: vi.fn() }));
vi.mock("../../db/pool.js", () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));
vi.mock("../../feeds/coinbaseWs.js", () => ({ isCoinbaseStaleFor: () => false }));
const logger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock("../../observability/logContext.js", () => ({ logger }));

import { config } from "../../config";
import {
    startKrakenFeed,
    stopKrakenFeed,
    getKrakenWsHealth,
    __debugFaultKrakenSocket,
    __resetKrakenWsForTest,
} from "../krakenWs";
import { getFeedHealthSnapshot, __resetFeedHealthForTest } from "../../observability/feedHealth";
import { __resetKrakenReconnectTrackerForTest } from "../krakenReconnectTracker";

const saved = {
    kill: config.feedWatchdogKillEnabled,
    hbKill: config.feedKrakenHeartbeatKillEnabled,
    backfill: config.candleBackfillOnBoot,
    enabled: config.krakenWsEnabled,
};

const msg = (o: unknown) => Buffer.from(JSON.stringify(o));
const heartbeat = () => msg({ channel: "heartbeat" });
const book = (symbol: string) =>
    msg({ channel: "book", type: "update", data: [{ symbol, bids: [], asks: [], timestamp: new Date().toISOString() }] });
const ticker = (symbol: string) =>
    msg({ channel: "ticker", type: "update", data: [{ symbol, last: 100, bid: 99, ask: 101 }] });

const current = () => sockets[sockets.length - 1] as EventEmitter & Record<string, any>;
const reconnectsOf = (cause?: string) =>
    getFeedHealthSnapshot().reconnects.kraken!.recent.filter((r) => !cause || r.cause === cause);
const logged = (event: string) => logger.warn.mock.calls.filter((c) => c[1] === event).map((c) => c[0]);

async function open(socket = current()) {
    socket.readyState = 1;
    socket.emit("open");
    await vi.advanceTimersByTimeAsync(0); // let the async open handler load symbols + subscribe
}

/**
 * Advance `seconds`, one second at a time, delivering what a live socket
 * sends each second: heartbeat, book updates for `books`, ticker for `tickers`.
 */
async function pump(seconds: number, f: { heartbeat?: boolean; books?: string[]; tickers?: string[] } = {}) {
    for (let i = 0; i < seconds; i++) {
        const s = current();
        if (s.readyState === 1 && s.listenerCount("message") > 0) {
            if (f.heartbeat ?? true) s.emit("message", heartbeat());
            for (const b of f.books ?? SYMBOLS) s.emit("message", book(b));
            for (const t of f.tickers ?? []) s.emit("message", ticker(t));
        }
        await vi.advanceTimersByTimeAsync(1_000);
    }
}

describe("krakenWs watchdogs", () => {
    beforeEach(async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_700_000_000_000);
        vi.spyOn(Math, "random").mockReturnValue(0.5); // no jitter → exact backoff delays
        config.candleBackfillOnBoot = false;
        config.krakenWsEnabled = true;
        config.feedWatchdogKillEnabled = false;
        config.feedKrakenHeartbeatKillEnabled = true;
        __resetKrakenWsForTest();
        __resetFeedHealthForTest();
        __resetKrakenReconnectTrackerForTest();
        logger.warn.mockClear();
        logger.info.mockClear();
        sockets.length = 0;

        startKrakenFeed();
        await open();
        await pump(3, { tickers: SYMBOLS }); // healthy start: lastTickAt set, every symbol seen
    });

    afterEach(() => {
        stopKrakenFeed();
        config.feedWatchdogKillEnabled = saved.kill;
        config.feedKrakenHeartbeatKillEnabled = saved.hbKill;
        config.candleBackfillOnBoot = saved.backfill;
        config.krakenWsEnabled = saved.enabled;
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it("reports per-symbol book health on /health's krakenWs object", () => {
        const h = getKrakenWsHealth();
        expect(h.status).toBe("connected");
        expect(h.bookKillEnabled).toBe(false);
        expect(h.heartbeatAgeMs).toBeLessThanOrEqual(1_000);
        expect(Object.keys(h.symbols)).toEqual(SYMBOLS);
        for (const s of SYMBOLS) expect(h.symbols[s]).toMatchObject({ status: "ok" });
    });

    it("heartbeat silence (stalled socket) → terminate(), not close(), and exactly one reconnect", async () => {
        const first = current();
        expect(__debugFaultKrakenSocket("stall")).toBe(true);
        await pump(6, { heartbeat: false, books: [], tickers: [] }); // the fake's pause() stops nothing, so stop feeding

        expect(first.terminate).toHaveBeenCalledTimes(1);
        expect(first.close).not.toHaveBeenCalled();
        expect(reconnectsOf()).toEqual([
            expect.objectContaining({ cause: "watchdog_heartbeat_stale", detail: expect.stringMatching(/^no heartbeat for \d+ms$/) }),
        ]);
        expect(logged("feed_watchdog_kill")).toEqual([
            expect.objectContaining({ exchange: "kraken", cause: "watchdog_heartbeat_stale", symbol: "_connection", thresholdMs: 5_000 }),
        ]);

        // The dead socket's late events must not schedule a second reconnect.
        first.emit("close", 1006, Buffer.from(""));
        first.emit("error", new Error("late"));
        await vi.advanceTimersByTimeAsync(1_000); // backoff attempt 1 = 1s
        expect(sockets).toHaveLength(2);
        expect(reconnectsOf()).toHaveLength(1);

        // The new socket comes up healthy.
        await open();
        await pump(3, { tickers: SYMBOLS });
        expect(getKrakenWsHealth().status).toBe("connected");
        expect(sockets).toHaveLength(2);
    });

    it("per-symbol book stale with kills disabled → feed_watchdog_would_kill once, socket kept", async () => {
        await pump(20, { books: ["BTC/USD", "ETH/USD"], tickers: ["BTC/USD"] });

        expect(current().terminate).not.toHaveBeenCalled();
        expect(sockets).toHaveLength(1);
        expect(reconnectsOf()).toEqual([]);
        expect(logged("feed_watchdog_would_kill")).toEqual([
            expect.objectContaining({
                exchange: "kraken",
                cause: "watchdog_book_stale",
                symbol: "SOL/USD",
                thresholdMs: 10_000,
                silentMs: expect.any(Number),
            }),
        ]);
        expect(logged("feed_watchdog_would_kill")[0].silentMs).toBeGreaterThan(10_000);

        const h = getKrakenWsHealth();
        expect(h.symbols["SOL/USD"]!.status).toBe("stale");
        expect(h.symbols["BTC/USD"]!.status).toBe("ok");
        expect(h.status).toBe("stale");

        const metrics = [
            await client.register.getSingleMetricAsString("tradr_feed_watchdog_trips_total"),
            await client.register.getSingleMetricAsString("tradr_feed_symbol_stale"),
        ].join("\n");
        expect(metrics).toContain(
            'tradr_feed_watchdog_trips_total{exchange="kraken",cause="watchdog_book_stale",symbol="SOL/USD",action="would_kill"} 1',
        );
        expect(metrics).toContain('tradr_feed_symbol_stale{exchange="kraken",channel="book",symbol="SOL/USD"} 1');
        expect(metrics).toContain('tradr_feed_symbol_stale{exchange="kraken",channel="book",symbol="BTC/USD"} 0');

        // SOL recovers → the gauge and health clear.
        await pump(1, { tickers: ["BTC/USD"] });
        expect(getKrakenWsHealth().symbols["SOL/USD"]!.status).toBe("ok");
    });

    it("per-symbol book stale with FEED_WATCHDOG_KILL_ENABLED → terminate + reconnect", async () => {
        config.feedWatchdogKillEnabled = true;
        const first = current();
        await pump(9, { books: ["BTC/USD", "ETH/USD"], tickers: ["BTC/USD"] });
        expect(first.terminate).not.toHaveBeenCalled(); // 10s threshold not crossed yet
        await pump(3, { books: ["BTC/USD", "ETH/USD"], tickers: ["BTC/USD"] });

        expect(first.terminate).toHaveBeenCalledTimes(1);
        expect(reconnectsOf()).toEqual([
            expect.objectContaining({ cause: "watchdog_book_stale", detail: expect.stringMatching(/^no book for SOL\/USD for \d+ms$/) }),
        ]);
        expect(logged("feed_watchdog_kill")).toEqual([expect.objectContaining({ symbol: "SOL/USD" })]);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(sockets).toHaveLength(2);
    });

    it("30s ticker safety net recovers a socket whose data stopped while heartbeats continue (book kills off)", async () => {
        const first = current();
        // Heartbeats keep the heartbeat watchdog happy; book + ticker go silent.
        await pump(29, { books: [], tickers: [] });
        expect(first.terminate).not.toHaveBeenCalled();
        expect(logged("feed_watchdog_would_kill").map((l) => l.symbol).sort()).toEqual(SYMBOLS.slice().sort());

        await pump(3, { books: [], tickers: [] });
        expect(first.terminate).toHaveBeenCalledTimes(1);
        expect(reconnectsOf()).toEqual([expect.objectContaining({ cause: "watchdog_stale" })]);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(sockets).toHaveLength(2);
    });

    it("does not re-kill the fresh socket for the previous socket's ticker silence", async () => {
        await pump(32, { books: [], tickers: [] }); // safety net kills socket 1
        await vi.advanceTimersByTimeAsync(1_000);
        expect(sockets).toHaveLength(2);

        // Socket 2: Kraken's first ticker arrives ~1.3s after open (measured). lastTickAt is
        // still >30s old until then; the safety net must measure from this socket's open.
        await open();
        await pump(2, { tickers: [] });
        await pump(30, { tickers: SYMBOLS });
        expect(current().terminate).not.toHaveBeenCalled();
        expect(sockets).toHaveLength(2);
        expect(reconnectsOf()).toHaveLength(1);
    });

    it("30s ticker safety net also fires on a fresh socket that never gets a ticker", async () => {
        current().emit("close", 1006, Buffer.from(""));
        await vi.advanceTimersByTimeAsync(1_000);
        await open();
        const second = current();
        await pump(29, { tickers: [] });
        expect(second.terminate).not.toHaveBeenCalled();
        await pump(3, { tickers: [] });
        expect(second.terminate).toHaveBeenCalledTimes(1);
        expect(reconnectsOf("watchdog_stale")).toHaveLength(1);
    });

    it("30s ticker safety net still recovers a fully stalled socket with every other kill disabled", async () => {
        config.feedKrakenHeartbeatKillEnabled = false;
        const first = current();
        __debugFaultKrakenSocket("stall");
        await pump(29, { heartbeat: false, books: [], tickers: [] });
        expect(first.terminate).not.toHaveBeenCalled();
        expect(logged("feed_watchdog_would_kill").map((l) => l.cause)).toContain("watchdog_heartbeat_stale");

        await pump(3, { heartbeat: false, books: [], tickers: [] });
        expect(first.terminate).toHaveBeenCalledTimes(1);
        expect(first.close).not.toHaveBeenCalled();
        expect(reconnectsOf()).toEqual([expect.objectContaining({ cause: "watchdog_stale" })]);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(sockets).toHaveLength(2);
    });

    it("backs off exponentially across connect-then-drop cycles instead of resetting on open", async () => {
        const delays: number[] = [];
        for (let i = 0; i < 5; i++) {
            const s = current();
            s.emit("close", 1006, Buffer.from(""));
            const scheduled = logger.info.mock.calls.filter((c) => c[1] === "kraken_ws_reconnect_scheduled");
            const delay = scheduled[scheduled.length - 1]![0].delay as number;
            delays.push(delay);
            await vi.advanceTimersByTimeAsync(delay);
            await open();
            await pump(2, { tickers: SYMBOLS }); // brief data, then it drops again
        }
        expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000]);
        expect(reconnectsOf("socket_close")).toHaveLength(5);
    });

    it("an error event terminates the socket instead of waiting on a close handshake", async () => {
        const first = current();
        first.emit("error", new Error("ECONNRESET"));
        expect(first.terminate).toHaveBeenCalledTimes(1);
        expect(first.close).not.toHaveBeenCalled();
        expect(reconnectsOf()).toEqual([expect.objectContaining({ cause: "socket_error", detail: "ECONNRESET" })]);
        expect(getKrakenWsHealth().status).toBe("disconnected");
    });
});
