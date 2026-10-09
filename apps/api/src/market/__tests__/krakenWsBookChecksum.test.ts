import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { EventEmitter } from "node:events";
import client from "prom-client";

// ── Fake socket (same shape as krakenWsWatchdog.test.ts) ──
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
// getSnapshot backs priceCollar's ticker fallback.
vi.mock("../snapshotStore", () => ({
    setSnapshot: vi.fn(async () => {}),
    getSnapshot: vi.fn(async () => ({ bid: "45283.0", ask: "45286.0", last: "45284.0", ts: new Date().toISOString(), source: "live" })),
}));
vi.mock("../../events/eventBus", () => ({ publish: vi.fn() }));
vi.mock("../../db/pool.js", () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));
vi.mock("../../feeds/coinbaseWs.js", () => ({ isCoinbaseStaleFor: () => false }));
const logger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock("../../observability/logContext.js", () => ({ logger }));

import { config } from "../../config";
import { startKrakenFeed, stopKrakenFeed, __resetKrakenWsForTest } from "../krakenWs";
import { KrakenBook, type RawBookLevel } from "../krakenBook";
import { bookSnapshots } from "../orderFlowFeatures";
import { getMarketReference } from "../../trading/priceCollar";
import { getFeedHealthSnapshot, __resetFeedHealthForTest } from "../../observability/feedHealth";
import { __resetKrakenReconnectTrackerForTest } from "../krakenReconnectTracker";

const saved = {
    enforce: config.krakenBookChecksumEnforce,
    cooldown: config.krakenBookResyncCooldownMs,
    timeout: config.krakenBookResyncTimeoutMs,
    massSymbols: config.krakenBookMassMismatchSymbols,
    massWindow: config.krakenBookMassMismatchWindowMs,
    backfill: config.candleBackfillOnBoot,
    enabled: config.krakenWsEnabled,
    kill: config.feedWatchdogKillEnabled,
};

// Kraken's published example book (docs spot-ws-book-v2, checksum 3310070434), BTC precision 1/8.
const ASKS: [string, string][] = [
    ["45285.2", "0.00100000"], ["45286.4", "1.54571953"], ["45286.6", "1.54571109"], ["45289.6", "1.54560911"],
    ["45290.2", "0.15890660"], ["45291.8", "1.54553491"], ["45294.7", "0.04454749"], ["45296.1", "0.35380000"],
    ["45297.5", "0.09945542"], ["45299.5", "0.18772827"],
];
const BIDS: [string, string][] = [
    ["45283.5", "0.10000000"], ["45283.4", "1.54582015"], ["45282.1", "0.10000000"], ["45281.0", "0.10000000"],
    ["45280.3", "1.54592586"], ["45279.0", "0.07990000"], ["45277.6", "0.03310103"], ["45277.5", "0.30000000"],
    ["45277.3", "1.54602737"], ["45276.6", "0.15445238"],
];
const PRECISION = { price: 1, qty: 8 };

const toRaw = (ls: [string, string][]): RawBookLevel[] => ls.map(([price, qty]) => ({ price, qty }));
// Raw wire text: price/qty as bare JSON numbers with Kraken's trailing zeros, exactly as Kraken sends them.
const levelsJson = (ls: [string, string][]) => `[${ls.map(([p, q]) => `{"price":${p},"qty":${q}}`).join(",")}]`;
const bookFrame = (type: "snapshot" | "update", symbol: string, bids: [string, string][], asks: [string, string][], checksum?: number) =>
    Buffer.from(
        `{"channel":"book","type":"${type}","data":[{"symbol":"${symbol}","bids":${levelsJson(bids)},"asks":${levelsJson(asks)}` +
        `${checksum === undefined ? "" : `,"checksum":${checksum}`},"timestamp":"${new Date().toISOString()}"}]}`,
    );
const instrumentFrame = (symbols: string[]) =>
    Buffer.from(JSON.stringify({
        channel: "instrument",
        type: "snapshot",
        data: { assets: [], pairs: symbols.map((symbol) => ({ symbol, price_precision: PRECISION.price, qty_precision: PRECISION.qty })) },
    }));
const heartbeat = () => Buffer.from(JSON.stringify({ channel: "heartbeat" }));
const ticker = (symbol: string) =>
    Buffer.from(JSON.stringify({ channel: "ticker", type: "update", data: [{ symbol, last: 45284, bid: 45283, ask: 45286 }] }));

const current = () => sockets[sockets.length - 1] as EventEmitter & Record<string, any>;
const logged = (level: "warn" | "info", event: string) =>
    logger[level].mock.calls.filter((c) => c[1] === event).map((c) => c[0]);
const reconnectsOf = (cause?: string) =>
    getFeedHealthSnapshot().reconnects.kraken!.recent.filter((r) => !cause || r.cause === cause);
const metric = async (name: string) => client.register.getSingleMetricAsString(name);
/** Parsed frames this socket sent since index `from`. */
const sentSince = (from: number, socket = current()) => socket.sent.slice(from).map((m: string) => JSON.parse(m));

/** Kraken's side of one symbol's book: emits frames with the checksum Kraken would send. */
class Exchange {
    readonly book = new KrakenBook(25);
    constructor(readonly symbol: string) {}
    snapshot(socket = current()) {
        this.book.applySnapshot(toRaw(BIDS), toRaw(ASKS));
        socket.emit("message", bookFrame("snapshot", this.symbol, BIDS, ASKS, this.book.checksum(PRECISION)));
    }
    /** A true update; `corrupt` delivers different levels than the checksum was computed over. */
    update(bids: [string, string][], asks: [string, string][], corrupt?: { bids?: [string, string][]; asks?: [string, string][] }) {
        this.book.applyUpdate(toRaw(bids), toRaw(asks));
        current().emit("message", bookFrame("update", this.symbol, corrupt?.bids ?? bids, corrupt?.asks ?? asks, this.book.checksum(PRECISION)));
    }
}

// One satoshi off a real qty change: the deliberately corrupted delta.
const GOOD_BID: [string, string][] = [["45283.5", "0.25000000"]];
const SATOSHI_OFF: [string, string][] = [["45283.5", "0.25000001"]];

async function open(socket = current()) {
    socket.readyState = 1;
    socket.emit("open");
    await vi.advanceTimersByTimeAsync(0);
}

/** Keep the socket's other watchdogs happy (heartbeat + ticker) while time passes. */
async function idle(seconds: number) {
    for (let i = 0; i < seconds; i++) {
        const s = current();
        if (s.readyState === 1 && s.listenerCount("message") > 0) {
            s.emit("message", heartbeat());
            for (const t of SYMBOLS) s.emit("message", ticker(t));
        }
        await vi.advanceTimersByTimeAsync(1_000);
    }
}

async function boot(withPrecision = true) {
    startKrakenFeed();
    await open();
    if (withPrecision) current().emit("message", instrumentFrame(SYMBOLS));
}

describe("krakenWs book checksum", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(1_700_000_000_000);
        vi.spyOn(Math, "random").mockReturnValue(0.5);
        config.candleBackfillOnBoot = false;
        config.krakenWsEnabled = true;
        config.feedWatchdogKillEnabled = false;
        config.krakenBookChecksumEnforce = false;
        config.krakenBookResyncCooldownMs = 5_000;
        config.krakenBookResyncTimeoutMs = 10_000;
        config.krakenBookMassMismatchSymbols = 5;
        config.krakenBookMassMismatchWindowMs = 10_000;
        __resetKrakenWsForTest();
        __resetFeedHealthForTest();
        __resetKrakenReconnectTrackerForTest();
        bookSnapshots.clear();
        logger.warn.mockClear();
        logger.info.mockClear();
        sockets.length = 0;
    });

    afterEach(() => {
        stopKrakenFeed();
        config.krakenBookChecksumEnforce = saved.enforce;
        config.krakenBookResyncCooldownMs = saved.cooldown;
        config.krakenBookResyncTimeoutMs = saved.timeout;
        config.krakenBookMassMismatchSymbols = saved.massSymbols;
        config.krakenBookMassMismatchWindowMs = saved.massWindow;
        config.candleBackfillOnBoot = saved.backfill;
        config.krakenWsEnabled = saved.enabled;
        config.feedWatchdogKillEnabled = saved.kill;
        bookSnapshots.clear();
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it("subscribes to the instrument channel (precision) alongside the book", async () => {
        await boot();
        const channels = sentSince(0).map((m: any) => m.params.channel);
        expect(channels[0]).toBe("instrument");
        expect(channels).toContain("book");
    });

    it("verifies Kraken's own checksums on the snapshot and every update, publishing the exact book", async () => {
        await boot();
        const btc = new Exchange("BTC/USD");
        btc.snapshot();
        btc.update(GOOD_BID, [["45285.2", "0.00000000"]]); // change one level, delete another

        const snap = bookSnapshots.get("pair-BTC/USD")!;
        expect(snap.bids[0]).toEqual({ price: 45283.5, qty: 0.25 });
        expect(snap.asks[0]).toEqual({ price: 45286.4, qty: 1.54571953 });
        expect(await metric("tradr_kraken_book_checksum_total")).toContain(
            'tradr_kraken_book_checksum_total{symbol="BTC/USD",result="ok"} 2',
        );
        expect(logged("warn", "kraken_book_checksum_mismatch")).toEqual([]);
    });

    it("no precision yet → accepted unverified and counted", async () => {
        await boot(false);
        new Exchange("BTC/USD").snapshot();
        expect(bookSnapshots.get("pair-BTC/USD")).toBeDefined();
        expect(await metric("tradr_kraken_book_checksum_total")).toContain(
            'tradr_kraken_book_checksum_total{symbol="BTC/USD",result="unverified_no_precision"} 1',
        );
    });

    describe("observe mode (KRAKEN_BOOK_CHECKSUM_ENFORCE=false, the default)", () => {
        it("defaults to off", () => {
            expect(saved.enforce).toBe(false);
        });

        it("a corrupted delta is logged + counted, but the book is kept and nothing is resubscribed", async () => {
            await boot();
            const btc = new Exchange("BTC/USD");
            btc.snapshot();
            const mark = current().sent.length;

            btc.update(GOOD_BID, [], { bids: SATOSHI_OFF });

            expect(logged("warn", "kraken_book_checksum_mismatch")).toEqual([
                expect.objectContaining({
                    exchange: "kraken", symbol: "BTC/USD", messageType: "update", enforce: false,
                    expected: expect.any(Number), computed: expect.any(Number),
                    top: expect.objectContaining({ bid: { price: "45283.5", qty: "0.25000001" } }),
                }),
            ]);
            expect(await metric("tradr_kraken_book_checksum_total")).toContain(
                'tradr_kraken_book_checksum_total{symbol="BTC/USD",result="mismatch"} 1',
            );
            expect(bookSnapshots.get("pair-BTC/USD")!.bids[0]).toEqual({ price: 45283.5, qty: 0.25000001 }); // unchanged behavior
            expect(sentSince(mark)).toEqual([]);
            expect(await metric("tradr_kraken_book_invalid")).not.toContain("BTC/USD");
        });

        it("a drifted book counts every mismatch but logs at most once per 10s, with the suppressed count", async () => {
            await boot();
            const btc = new Exchange("BTC/USD");
            btc.snapshot();
            btc.update(GOOD_BID, [], { bids: SATOSHI_OFF }); // drift starts
            for (let i = 0; i < 5; i++) btc.update([["45276.6", `0.1544523${i}`]], []); // still drifted
            expect(logged("warn", "kraken_book_checksum_mismatch")).toHaveLength(1);
            expect(await metric("tradr_kraken_book_checksum_total")).toContain(
                'tradr_kraken_book_checksum_total{symbol="BTC/USD",result="mismatch"} 6',
            );

            await idle(11);
            btc.update([["45276.6", "0.15445238"]], []);
            expect(logged("warn", "kraken_book_checksum_mismatch")).toEqual([
                expect.anything(),
                expect.objectContaining({ suppressedSinceLastLog: 5 }),
            ]);
        });
    });

    describe("enforce mode (KRAKEN_BOOK_CHECKSUM_ENFORCE=true)", () => {
        beforeEach(() => {
            config.krakenBookChecksumEnforce = true;
        });

        it("a corrupted delta drops that book, falls the collar back to the ticker, and resubscribes only that symbol's book", async () => {
            await boot();
            const btc = new Exchange("BTC/USD");
            const eth = new Exchange("ETH/USD");
            btc.snapshot();
            eth.snapshot();
            expect((await getMarketReference("pair-BTC/USD", "BTC/USD"))!.source).toBe("book");
            const mark = current().sent.length;

            btc.update(GOOD_BID, [], { bids: SATOSHI_OFF });

            expect(bookSnapshots.has("pair-BTC/USD")).toBe(false);
            expect(bookSnapshots.has("pair-ETH/USD")).toBe(true);
            expect((await getMarketReference("pair-BTC/USD", "BTC/USD"))!.source).toBe("ticker");
            expect(sentSince(mark)).toEqual([
                { method: "unsubscribe", params: { channel: "book", depth: 25, symbol: ["BTC/USD"], snapshot: true } },
                { method: "subscribe", params: { channel: "book", depth: 25, symbol: ["BTC/USD"], snapshot: true } },
            ]);
            expect(logged("warn", "kraken_book_checksum_mismatch")).toEqual([expect.objectContaining({ symbol: "BTC/USD", enforce: true })]);
            expect(logged("warn", "kraken_book_resync_requested")).toEqual([expect.objectContaining({ symbol: "BTC/USD" })]);
            expect(await metric("tradr_kraken_book_invalid")).toContain('tradr_kraken_book_invalid{symbol="BTC/USD"} 1');
            expect(await metric("tradr_kraken_book_resyncs_total")).toContain(
                'tradr_kraken_book_resyncs_total{symbol="BTC/USD",outcome="requested"} 1',
            );
            expect(current().terminate).not.toHaveBeenCalled();
        });

        it("ignores in-flight updates until the fresh snapshot, which restores the book", async () => {
            await boot();
            const btc = new Exchange("BTC/USD");
            btc.snapshot();
            btc.update(GOOD_BID, [], { bids: SATOSHI_OFF });

            btc.update([["45283.4", "2.00000000"]], []); // stale in-flight update
            expect(bookSnapshots.has("pair-BTC/USD")).toBe(false);

            btc.snapshot();
            expect(bookSnapshots.get("pair-BTC/USD")!.bids[0]).toEqual({ price: 45283.5, qty: 0.1 });
            expect(await metric("tradr_kraken_book_invalid")).not.toContain("BTC/USD");
            expect(await metric("tradr_kraken_book_resyncs_total")).toContain(
                'tradr_kraken_book_resyncs_total{symbol="BTC/USD",outcome="recovered"} 1',
            );
            expect(logged("info", "kraken_book_resync_recovered")).toEqual([expect.objectContaining({ symbol: "BTC/USD" })]);

            // Verified again from the fresh snapshot on.
            btc.update(GOOD_BID, []);
            expect(bookSnapshots.get("pair-BTC/USD")!.bids[0]).toEqual({ price: 45283.5, qty: 0.25 });
        });

        it("a second mismatch inside the cooldown waits; the watchdog resubscribes once it passes", async () => {
            await boot();
            const btc = new Exchange("BTC/USD");
            btc.snapshot();
            btc.update(GOOD_BID, [], { bids: SATOSHI_OFF });
            btc.snapshot(); // recovered
            await idle(1);
            const mark = current().sent.length;

            btc.update([["45283.4", "2.00000000"]], [], { bids: [["45283.4", "2.00000001"]] }); // again, 1s later
            expect(bookSnapshots.has("pair-BTC/USD")).toBe(false);
            expect(sentSince(mark).filter((m: any) => m.params.channel === "book")).toEqual([]);

            await idle(5);
            const resent = sentSince(mark).filter((m: any) => m.params.channel === "book");
            expect(resent.map((m: any) => [m.method, m.params.symbol])).toEqual([
                ["unsubscribe", ["BTC/USD"]],
                ["subscribe", ["BTC/USD"]],
            ]);
            expect(current().terminate).not.toHaveBeenCalled();
        });

        it("no fresh snapshot within the timeout → one socket reconnect, books rebuilt from the new socket", async () => {
            await boot();
            const btc = new Exchange("BTC/USD");
            btc.snapshot();
            btc.update(GOOD_BID, [], { bids: SATOSHI_OFF });
            const first = current();

            await idle(11);

            expect(first.terminate).toHaveBeenCalledTimes(1);
            expect(reconnectsOf()).toEqual([
                expect.objectContaining({ cause: "book_resync_timeout", detail: expect.stringContaining("BTC/USD") }),
            ]);
            expect(await metric("tradr_kraken_book_invalid")).not.toContain("BTC/USD");

            await vi.advanceTimersByTimeAsync(1_000); // backoff
            expect(sockets).toHaveLength(2);
            await open();
            current().emit("message", instrumentFrame(SYMBOLS));
            btc.snapshot();
            expect(bookSnapshots.get("pair-BTC/USD")!.bids[0]).toEqual({ price: 45283.5, qty: 0.1 });
            expect(reconnectsOf()).toHaveLength(1);
        });

        it("many symbols mismatching at once → one reconnect instead of N resubscribes", async () => {
            config.krakenBookMassMismatchSymbols = 3;
            await boot();
            const exchanges = SYMBOLS.map((s) => new Exchange(s));
            for (const x of exchanges) x.snapshot();
            const first = current();

            for (const x of exchanges) x.update(GOOD_BID, [], { bids: SATOSHI_OFF });

            expect(first.terminate).toHaveBeenCalledTimes(1);
            expect(reconnectsOf()).toEqual([
                expect.objectContaining({ cause: "book_checksum_mass_mismatch", detail: expect.stringContaining("3 symbols") }),
            ]);
            // The first two got per-symbol resyncs before the threshold tripped; the third did not.
            const resubs = first.sent.map((m: string) => JSON.parse(m))
                .filter((m: any) => m.method === "unsubscribe" && m.params.channel === "book");
            expect(resubs.map((m: any) => m.params.symbol)).toEqual([["BTC/USD"], ["ETH/USD"]]);
            expect(await metric("tradr_kraken_book_invalid")).not.toMatch(/tradr_kraken_book_invalid\{[^}]*\} 1/); // reset by the reconnect
        });

        it("a malformed level is treated like a mismatch", async () => {
            await boot();
            const btc = new Exchange("BTC/USD");
            btc.snapshot();
            current().emit("message", Buffer.from(
                '{"channel":"book","type":"update","data":[{"symbol":"BTC/USD","bids":[{"price":"abc","qty":1.0}],"asks":[],"checksum":1}]}',
            ));
            expect(bookSnapshots.has("pair-BTC/USD")).toBe(false);
            expect(logged("warn", "kraken_book_checksum_mismatch")).toEqual([
                expect.objectContaining({ symbol: "BTC/USD", err: expect.stringContaining("invalid decimal") }),
            ]);
        });
    });
});
