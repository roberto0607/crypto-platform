import WebSocket from "ws";
import { setSnapshot } from "./snapshotStore";
import { publish } from "../events/eventBus";
import { createEvent } from "../events/eventTypes";
import { loadActiveSymbols, type ActiveSymbol } from "./symbolRegistry.js";
import { pool } from "../db/pool.js";
import { config } from "../config.js";
import { aggregateTick, flushDueCandles } from "./candleAggregator.js";
import { candleSourceFor } from "./candleSource.js";
import { seedOpenCandlesFromKrakenRest } from "./formingCandle.js";
import { runBackfill } from "./candleBackfill.js";
import { logger } from "../observability/logContext.js";
import {
    computeOrderFlowFeatures,
    bookSnapshots,
    orderFlowCache,
} from "./orderFlowFeatures.js";
import { krakenTradeSide, addSample as addPressureSample } from "../services/pressureAggregator.js";
import { eventsPublishedTotal } from "../metrics.js";
import { isCoinbaseStaleFor } from "../feeds/coinbaseWs.js";
import { recordKrakenReconnectAttempt, isKrakenReconnectBudgetExceeded, KRAKEN_BACKOFF } from "./krakenReconnectTracker.js";
import {
    recordFeedTick,
    recordFeedReconnect,
    recordWatchdogTrip,
    setFeedStale,
    clearFeedStale,
    setReconnectBackoff,
    recordBookChecksum,
    recordBookResync,
    setBookInvalid,
    clearBookInvalid,
    type ReconnectCause,
} from "../observability/feedHealth.js";
import { StalenessTracker, ReconnectBackoff, type StaleEpisode } from "./feedWatchdog.js";
import { KrakenBook, quoteBookNumbers, type KrakenPrecision, type RawBookLevel } from "./krakenBook.js";

// Debounce: track last DB write time per pair to avoid write storms
const lastSyncTime = new Map<string, number>();

const KRAKEN_WS_URL = "wss://ws.kraken.com/v2";

// DB-driven active symbol set (trading_pairs × exchange_symbol_map) —
// replaces the old hardcoded SYMBOL_MAP literal. Populated by
// refreshSymbols() on connect and re-polled every SYMBOL_REFRESH_INTERVAL_MS
// so new/delisted pairs are picked up without a reconnect.
let activeSymbols: ActiveSymbol[] = [];
let wsToOurSymbol: Record<string, string> = {};

// our symbol → pair UUID — exported for krakenBookRoutes.ts.
export let symbolToPairId: Record<string, string> = {};
let symbolsReady = false;

const SYMBOL_REFRESH_INTERVAL_MS = 5 * 60_000;
let symbolRefreshInterval: ReturnType<typeof setInterval> | null = null;

async function refreshSymbols(): Promise<ActiveSymbol[]> {
    try {
        const symbols = await loadActiveSymbols("kraken");
        activeSymbols = symbols;
        wsToOurSymbol = Object.fromEntries(symbols.map((s) => [s.wsSymbol, s.ourSymbol]));
        symbolToPairId = Object.fromEntries(symbols.map((s) => [s.ourSymbol, s.pairId]));
        symbolsReady = true;
        return symbols;
    } catch {
        // Will retry on next connect / next refresh tick
        return activeSymbols;
    }
}

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let stopped = false;
let flushInterval: ReturnType<typeof setInterval> | null = null;
let watchdogInterval: ReturnType<typeof setInterval> | null = null;
let backfillDone = false;
let formingSeedDone = false;

// KRAKEN_BACKOFF + the combined 10-min reconnect budget are shared with
// footprintAggregator.ts's socket (krakenReconnectTracker.ts).
let backoff = new ReconnectBackoff(KRAKEN_BACKOFF);

// ── Watchdogs (checked every WATCHDOG_CHECK_MS) ──
//  1. Safety net: no ticker message on ANY symbol for 30s → kill. Ticker only
//     fires on trades (per-symbol gaps of 15s are normal), hence whole-socket.
//  2. Heartbeat: Kraken's v2 heartbeat (~1/s) silent for
//     feedKrakenHeartbeatStaleMs → kill. Catches a dead or half-open socket.
//  3. Per-symbol book: no book message for one symbol for
//     feedKrakenBookStaleMs → kill only if FEED_WATCHDOG_KILL_ENABLED, else
//     log feed_watchdog_would_kill. Catches one symbol's subscription dying
//     while the rest of the socket (and so 1 and 2) looks healthy.
// "Kill" is always terminate(): close() waits for a closing handshake a
// half-open socket never answers (the ws lib's 30s close timeout).
const WATCHDOG_TIMEOUT_MS = 30_000;
const WATCHDOG_CHECK_MS = 1_000;
const HEARTBEAT_KEY = "heartbeat";
const CONNECTION_SYMBOL = "_connection";
let lastTickAt = 0;
// When the current socket opened. The safety net measures from the later of
// this and lastTickAt, so a fresh socket isn't killed for the previous one's
// silence before its first ticker arrives.
let socketOpenedAt = 0;
let wsConnected = false;

const trackerOpts = () => ({ graceMs: config.feedWatchdogGraceMs, maxCheckGapMs: 3 * WATCHDOG_CHECK_MS });
let bookTracker = new StalenessTracker({ staleMs: config.feedKrakenBookStaleMs, ...trackerOpts() });
let heartbeatTracker = new StalenessTracker({ staleMs: config.feedKrakenHeartbeatStaleMs, ...trackerOpts() });

export type KrakenSymbolHealth = {
    bookAgeMs: number | null;
    status: "ok" | "stale" | "waiting";
};

export function getKrakenWsHealth(): {
    connected: boolean;
    lastTickAt: number;
    secondsSinceLastTick: number;
    status: "connected" | "stale" | "disconnected";
    heartbeatAgeMs: number | null;
    bookKillEnabled: boolean;
    symbols: Record<string, KrakenSymbolHealth>;
} {
    const now = Date.now();
    const secondsSinceLastTick = lastTickAt > 0
        ? Math.round((now - lastTickAt) / 1000)
        : -1;

    const symbols: Record<string, KrakenSymbolHealth> = {};
    let anyBookStale = false;
    for (const s of activeSymbols) {
        const bookAgeMs = wsConnected ? bookTracker.ageOf(s.ourSymbol, now) : null;
        const stale = wsConnected && bookTracker.isStale(s.ourSymbol);
        anyBookStale ||= stale;
        symbols[s.ourSymbol] = { bookAgeMs, status: stale ? "stale" : bookAgeMs === null ? "waiting" : "ok" };
    }

    const status = !wsConnected
        ? "disconnected"
        : secondsSinceLastTick > 30 || anyBookStale || heartbeatTracker.isStale(HEARTBEAT_KEY)
            ? "stale"
            : "connected";
    return {
        connected: wsConnected,
        lastTickAt,
        secondsSinceLastTick,
        status,
        heartbeatAgeMs: wsConnected ? heartbeatTracker.ageOf(HEARTBEAT_KEY, now) : null,
        bookKillEnabled: config.feedWatchdogKillEnabled,
        symbols,
    };
}

function sendSubscription(socket: WebSocket, method: "subscribe" | "unsubscribe", symbols: string[]): void {
    if (symbols.length === 0) return;

    socket.send(JSON.stringify({ method, params: { channel: "ticker", symbol: symbols } }));
    socket.send(JSON.stringify({ method, params: { channel: "trade", symbol: symbols, snapshot: false } }));
    sendBookSubscription(socket, method, symbols);
}

function sendBookSubscription(socket: WebSocket, method: "subscribe" | "unsubscribe", symbols: string[]): void {
    socket.send(JSON.stringify({ method, params: { channel: "book", depth: BOOK_DEPTH, symbol: symbols, snapshot: true } }));
}

function subscribe(socket: WebSocket): void {
    // Instrument first: its snapshot carries every pair's price/qty precision,
    // which the book checksum needs (a book seen before it is accepted unverified).
    socket.send(JSON.stringify({ method: "subscribe", params: { channel: "instrument", snapshot: true } }));
    sendSubscription(socket, "subscribe", activeSymbols.map((s) => s.wsSymbol));
}

/**
 * Re-fetch the active symbol set and diff it against what this connection is
 * currently subscribed to, sending incremental subscribe/unsubscribe
 * messages for just the delta — no reconnect. Runs on a
 * SYMBOL_REFRESH_INTERVAL_MS timer so new pairs (backfill script or the
 * periodic symbol-refresh job) and delistings are picked up live.
 */
async function reconcileSubscriptions(): Promise<void> {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    const beforeSymbols = activeSymbols;
    const before = new Set(beforeSymbols.map((s) => s.wsSymbol));
    const after = await refreshSymbols();
    const afterSet = new Set(after.map((s) => s.wsSymbol));

    const added = after.filter((s) => !before.has(s.wsSymbol)).map((s) => s.wsSymbol);
    const removed = [...before].filter((wsSymbol) => !afterSet.has(wsSymbol));

    if (added.length === 0 && removed.length === 0) return;

    sendSubscription(ws, "subscribe", added);
    sendSubscription(ws, "unsubscribe", removed);
    for (const s of beforeSymbols) {
        if (!afterSet.has(s.wsSymbol)) forgetBookState(s.ourSymbol);
    }
    logger.info({ added, removed }, "kraken_ws_subscriptions_reconciled");
}

async function handleTickerMessage(data: any[]): Promise<void> {
    lastTickAt = Date.now();
    backoff.onHealthy(lastTickAt);
    for (const tick of data) {
        const krakenSymbol = tick.symbol;
        const ourSymbol = wsToOurSymbol[krakenSymbol];
        if (!ourSymbol) continue;
        recordFeedTick("kraken_ticker", ourSymbol);

        const last = String(tick.last);
        const bid = tick.bid != null ? String(tick.bid) : null;
        const ask = tick.ask != null ? String(tick.ask) : null;

        await setSnapshot(ourSymbol, {
            bid,
            ask,
            last,
            ts: new Date().toISOString(),
        });

        const pairId = symbolToPairId[ourSymbol];
        if (pairId) {
            // Feed ticker into candle aggregator as safety net.
            // Volume "0" = synthetic tick — ensures candles form even with no trades.
            // Only for Kraken-sourced symbols (see candleSource.ts).
            if (candleSourceFor(ourSymbol) === "kraken") {
                aggregateTick(pairId, { price: last, volume: "0", ts: Date.now() });
            }

            // Fallback price.tick publish — Coinbase is the primary source
            // (coinbaseWs.ts's trade handler) as of Gate 1. Only publish here
            // if Coinbase is stale on THIS symbol, to avoid the two sources
            // ticking concurrently (recon found a persistent small
            // Kraken/Coinbase price divergence that would otherwise flicker
            // the hero price). Per-symbol: a global "any Coinbase trade"
            // clock let one busy symbol mask another symbol's dead feed.
            if (isCoinbaseStaleFor(ourSymbol)) {
                try {
                    publish(createEvent("price.tick", {
                        pairId,
                        symbol: ourSymbol,
                        bid,
                        ask,
                        last,
                        source: "kraken",
                    }));
                    eventsPublishedTotal.inc({ type: "price.tick" });
                } catch {
                    // Events must never break the feed
                }
            }

            // Sync last_price to DB (debounced)
            const now = Date.now();
            const lastSync = lastSyncTime.get(pairId) ?? 0;
            if (now - lastSync >= config.lastPriceSyncIntervalMs) {
                lastSyncTime.set(pairId, now);
                pool.query(
                    `UPDATE trading_pairs SET last_price = $1 WHERE id = $2`,
                    [last, pairId],
                ).catch((err) => {
                    logger.error({ err, pairId }, "last_price_sync_failed");
                });
            }
        }
    }
}

function handleTradeMessage(data: any[]): void {
    for (const trade of data) {
        const krakenSymbol = trade.symbol;
        const ourSymbol = wsToOurSymbol[krakenSymbol];
        if (!ourSymbol) continue;

        const pairId = symbolToPairId[ourSymbol];
        if (!pairId) continue;

        const price = String(trade.price);
        const volume = String(trade.qty);
        const ts = trade.timestamp
            ? new Date(trade.timestamp).getTime()
            : Date.now();
        // Kraken WS v2 trade channel includes 'side' ("buy" or "sell", taker).
        const side = krakenTradeSide(trade);
        recordFeedTick("kraken_trade", ourSymbol, trade.timestamp ? ts : null);

        if (candleSourceFor(ourSymbol) === "kraken") {
            aggregateTick(pairId, { price, volume, ts, side });
        }

        // Pressure aggregator hook — runs AFTER aggregateTick so a failure
        // here can never break the existing CVD/candle path.
        if (side) {
            try {
                addPressureSample(ourSymbol, {
                    ts,
                    side,
                    notional: Number(price) * Number(volume),
                });
            } catch {
                // Pressure ingestion must never disrupt the trade feed.
            }
        }
    }
}

const BOOK_DEPTH = 25;

// ── Book checksum ──
// Every book message is checked against Kraken's CRC32 (krakenBook.ts).
// Observe mode (default): mismatches are logged + counted, the book is kept.
// KRAKEN_BOOK_CHECKSUM_ENFORCE: a mismatched symbol's book is dropped (the
// collar falls back to the ticker, else rejects stale_price_source), its
// updates are ignored, and only its book is resubscribed for a fresh snapshot
// — at most once per cooldown, socket reconnect if the snapshot never comes
// or if many symbols mismatch at once.
const MISMATCH_LOG_INTERVAL_MS = 10_000;
// wsSymbol → precision, from the instrument channel. Kept across reconnects.
let precisions = new Map<string, KrakenPrecision>();
// ourSymbol → exact book. Absent = no snapshot yet, or dropped pending resync.
const books = new Map<string, KrakenBook>();
// ourSymbol → open resync (enforce mode): requestedAt null until the
// resubscribe is actually sent (it may wait out the cooldown).
const resyncs = new Map<string, { requestedAt: number | null }>();
// ourSymbol → last resubscribe sent; survives the episode so the cooldown spans episodes.
const lastResyncSentAt = new Map<string, number>();
// ourSymbol → last mismatch time, for the mass-mismatch window.
const recentMismatchAt = new Map<string, number>();
// ourSymbol → open mismatch episode's log throttle (closed by the next matching checksum).
const mismatchLog = new Map<string, { lastLoggedAt: number; suppressed: number }>();

function handleInstrumentMessage(data: any): void {
    for (const p of data?.pairs ?? []) {
        const price = Number(p?.price_precision);
        const qty = Number(p?.qty_precision);
        if (typeof p?.symbol === "string" && Number.isInteger(price) && Number.isInteger(qty)) {
            precisions.set(p.symbol, { price, qty });
        }
    }
}

function publishBook(pairId: string, book: KrakenBook): void {
    const { bids, asks } = book.toLevels();
    const ts = Date.now();
    bookSnapshots.set(pairId, { bids, asks, ts });
    const features = computeOrderFlowFeatures(bids, asks);
    orderFlowCache.set(pairId, { ...features, ts });
}

function applyBookEntry(entry: any, type: string, ourSymbol: string, pairId: string, now: number): void {
    const rawBids: RawBookLevel[] = entry.bids || [];
    const rawAsks: RawBookLevel[] = entry.asks || [];

    let book = books.get(ourSymbol);
    try {
        if (type === "snapshot") {
            book = new KrakenBook(BOOK_DEPTH);
            book.applySnapshot(rawBids, rawAsks);
            books.set(ourSymbol, book);
            if (resyncs.delete(ourSymbol)) {
                setBookInvalid(ourSymbol, false);
                recordBookResync(ourSymbol, "recovered");
                logger.info({ exchange: "kraken", symbol: ourSymbol }, "kraken_book_resync_recovered");
            }
        } else {
            if (!book) return; // no snapshot yet, or dropped pending a resync snapshot
            book.applyUpdate(rawBids, rawAsks);
        }
    } catch (err) {
        // A malformed level: the book can no longer be trusted — same path as a mismatch.
        onChecksumMismatch(ourSymbol, pairId, type, entry.checksum ?? null, null, book ?? null, now, err);
        return;
    }

    const expected = typeof entry.checksum === "number" ? entry.checksum >>> 0 : null;
    const precision = precisions.get(entry.symbol);
    if (expected === null || !precision) {
        // Accepted unverified (e.g. the book snapshot beat the instrument snapshot).
        recordBookChecksum(ourSymbol, expected === null ? "unverified_no_checksum" : "unverified_no_precision");
        publishBook(pairId, book);
        return;
    }

    const computed = book.checksum(precision);
    if (computed === expected) {
        recordBookChecksum(ourSymbol, "ok");
        mismatchLog.delete(ourSymbol);
        publishBook(pairId, book);
        return;
    }
    onChecksumMismatch(ourSymbol, pairId, type, expected, computed, book, now, null);
}

function onChecksumMismatch(
    ourSymbol: string,
    pairId: string,
    type: string,
    expected: number | null,
    computed: number | null,
    book: KrakenBook | null,
    now: number,
    err: unknown,
): void {
    const enforce = config.krakenBookChecksumEnforce;
    recordBookChecksum(ourSymbol, "mismatch");

    // Every mismatch is counted; the log is throttled within one episode (in
    // observe mode a drifted book mismatches on every update until it heals).
    const ep = mismatchLog.get(ourSymbol);
    if (ep && now - ep.lastLoggedAt < MISMATCH_LOG_INTERVAL_MS) {
        ep.suppressed++;
    } else {
        logger.warn(
            {
                exchange: "kraken", symbol: ourSymbol, messageType: type, expected, computed, enforce,
                top: book?.top() ?? null, suppressedSinceLastLog: ep?.suppressed ?? 0,
                ...(err ? { err: err instanceof Error ? err.message : String(err) } : {}),
            },
            "kraken_book_checksum_mismatch",
        );
        mismatchLog.set(ourSymbol, { lastLoggedAt: now, suppressed: 0 });
    }

    if (!enforce) {
        if (book) publishBook(pairId, book); // observe only: behavior unchanged
        return;
    }

    // Enforce: nothing may read this book until a fresh snapshot verifies.
    books.delete(ourSymbol);
    bookSnapshots.delete(pairId);
    orderFlowCache.delete(pairId);
    setBookInvalid(ourSymbol, true);
    resyncs.set(ourSymbol, { requestedAt: null });

    recentMismatchAt.set(ourSymbol, now);
    for (const [s, t] of recentMismatchAt) {
        if (now - t > config.krakenBookMassMismatchWindowMs) recentMismatchAt.delete(s);
    }
    if (recentMismatchAt.size >= config.krakenBookMassMismatchSymbols) {
        const symbols = [...recentMismatchAt.keys()];
        killSocket("book_checksum_mass_mismatch", CONNECTION_SYMBOL, 0, config.krakenBookMassMismatchWindowMs, true,
            `${symbols.length} symbols' book checksums failed within ${config.krakenBookMassMismatchWindowMs}ms: ${symbols.join(",")}`);
        return;
    }
    requestBookResync(ourSymbol, now);
}

/** Book-only unsubscribe + subscribe for one symbol, unless inside its cooldown (the watchdog retries). */
function requestBookResync(ourSymbol: string, now: number): void {
    const r = resyncs.get(ourSymbol);
    if (!r || r.requestedAt !== null || !ws || ws.readyState !== WebSocket.OPEN) return;
    const last = lastResyncSentAt.get(ourSymbol);
    if (last !== undefined && now - last < config.krakenBookResyncCooldownMs) return;
    const wsSymbol = activeSymbols.find((s) => s.ourSymbol === ourSymbol)?.wsSymbol;
    if (!wsSymbol) {
        forgetBookState(ourSymbol); // delisted meanwhile
        return;
    }
    r.requestedAt = now;
    lastResyncSentAt.set(ourSymbol, now);
    sendBookSubscription(ws, "unsubscribe", [wsSymbol]);
    sendBookSubscription(ws, "subscribe", [wsSymbol]);
    recordBookResync(ourSymbol, "requested");
    logger.warn({ exchange: "kraken", symbol: ourSymbol }, "kraken_book_resync_requested");
}

/** Watchdog step 4: send cooldown-delayed resyncs; reconnect if a snapshot never arrives. Returns true if it killed the socket. */
function checkBookResyncs(now: number): boolean {
    for (const [symbol, r] of resyncs) {
        if (r.requestedAt === null) {
            requestBookResync(symbol, now);
        } else if (now - r.requestedAt > config.krakenBookResyncTimeoutMs) {
            const waitedMs = now - r.requestedAt;
            if (killSocket("book_resync_timeout", symbol, waitedMs, config.krakenBookResyncTimeoutMs, true,
                `no fresh book snapshot for ${symbol} ${waitedMs}ms after resubscribe`)) return true;
        }
    }
    return false;
}

/** Drop one symbol's checksum/resync state (delisted). */
function forgetBookState(ourSymbol: string): void {
    books.delete(ourSymbol);
    resyncs.delete(ourSymbol);
    lastResyncSentAt.delete(ourSymbol);
    recentMismatchAt.delete(ourSymbol);
    mismatchLog.delete(ourSymbol);
    setBookInvalid(ourSymbol, false);
}

/** Per-connection book state: every book is rebuilt from the next socket's snapshots. */
function resetBookState(): void {
    books.clear();
    resyncs.clear();
    lastResyncSentAt.clear();
    recentMismatchAt.clear();
    mismatchLog.clear();
    clearBookInvalid();
}

function handleBookMessage(data: any[], type: string): void {
    const socket = ws;
    for (const entry of data) {
        if (ws !== socket) return; // a mass-mismatch kill dropped the socket mid-frame
        const krakenSymbol = entry.symbol;
        if (!krakenSymbol) continue;

        const ourSymbol = wsToOurSymbol[krakenSymbol];
        if (!ourSymbol) continue;

        const pairId = symbolToPairId[ourSymbol];
        if (!pairId) continue;
        recordFeedTick("kraken_book", ourSymbol, entry.timestamp ? new Date(entry.timestamp).getTime() : null);
        const now = Date.now();
        bookTracker.record(ourSymbol, now);
        backoff.onHealthy(now);

        applyBookEntry(entry, type, ourSymbol, pairId, now);
    }
}

async function handleMessage(raw: WebSocket.Data): Promise<void> {
    try {
        const text = raw.toString();
        // Book frames: quote price/qty first so they parse as exact decimal text.
        const msg = JSON.parse(text.includes('"channel":"book"') ? quoteBookNumbers(text) : text);
        if (msg.channel === "heartbeat") {
            heartbeatTracker.record(HEARTBEAT_KEY, Date.now());
            return;
        }
        // Accept both "update" and "snapshot" types for book channel
        if (msg.type !== "update" && msg.type !== "snapshot") return;

        if (msg.channel === "ticker") {
            await handleTickerMessage(msg.data);
        } else if (msg.channel === "trade") {
            handleTradeMessage(msg.data);
        } else if (msg.channel === "book") {
            handleBookMessage(msg.data, msg.type);
        } else if (msg.channel === "instrument") {
            handleInstrumentMessage(msg.data);
        }
    } catch {
        // Ignore unparseable messages (heartbeats, etc.)
    }
}

function connect(): void {
    if (stopped) return;

    const socket = new WebSocket(KRAKEN_WS_URL);
    ws = socket;

    socket.on("open", async () => {
        console.log("[krakenWs] connected");
        const now = Date.now();
        wsConnected = true;
        socketOpenedAt = now;
        backoff.onOpen(now);
        bookTracker.reset(now);
        heartbeatTracker.reset(now);
        if (!symbolsReady) await refreshSymbols();
        if (ws !== socket) return; // killed while symbols loaded
        subscribe(socket);
        if (!flushInterval) {
            flushInterval = setInterval(() => {
                flushDueCandles().catch((err: unknown) => {
                    logger.error({ err }, "candle_flush_failed");
                });
            }, 5_000);
        }

        // Live symbol reconciliation — picks up new pairs (backfill script,
        // periodic symbol-refresh job) and delistings without a reconnect.
        if (!symbolRefreshInterval) {
            symbolRefreshInterval = setInterval(() => {
                reconcileSubscriptions().catch((err: unknown) => {
                    logger.error({ err }, "kraken_ws_symbol_reconcile_failed");
                });
            }, SYMBOL_REFRESH_INTERVAL_MS);
        }

        // One-time: seed each Kraken-sourced pair's in-progress minute from
        // Kraken REST, so the boot minute keeps its real open (fire-and-forget).
        if (!formingSeedDone) {
            formingSeedDone = true;
            const pairs = Object.entries(symbolToPairId).map(([symbol, pairId]) => ({ symbol, pairId }));
            seedOpenCandlesFromKrakenRest(pairs)
                .then((seeded) => logger.info({ seeded }, "forming_candle_seed_complete"))
                .catch((e) => logger.error({ err: e }, "forming_candle_seed_failed"));
        }

        // One-time candle backfill on first connect (fire-and-forget)
        if (config.candleBackfillOnBoot && !backfillDone) {
            backfillDone = true;
            runBackfill()
                .then((r) => logger.info(r, "candle_backfill_complete"))
                .catch((e) => logger.error({ err: e }, "candle_backfill_failed"));
        }

        if (!watchdogInterval) {
            watchdogInterval = setInterval(runWatchdogs, WATCHDOG_CHECK_MS);
        }
    });

    socket.on("message", handleMessage);

    socket.on("close", (code: number, reason: Buffer) => {
        dropSocket(socket, "socket_close", null, code, reason.toString());
    });

    socket.on("error", (err) => {
        console.error("[krakenWs] error", err.message);
        dropSocket(socket, "socket_error", err.message);
    });
}

function runWatchdogs(): void {
    if (!ws || !wsConnected) return;
    const now = Date.now();

    // 1. 30s whole-socket ticker safety net — always kills.
    const silentSince = Math.max(lastTickAt, socketOpenedAt);
    if (now - silentSince > WATCHDOG_TIMEOUT_MS) {
        const silentMs = now - silentSince;
        console.log("[krakenWs] No ticks for 30s — reconnecting...");
        killSocket("watchdog_stale", CONNECTION_SYMBOL, silentMs, WATCHDOG_TIMEOUT_MS, true, `no ticker for ${silentMs}ms`);
        return;
    }

    // 2. Heartbeat.
    for (const ep of heartbeatTracker.check([HEARTBEAT_KEY], now)) {
        setFeedStale("kraken", "heartbeat", CONNECTION_SYMBOL, true);
        if (killSocket("watchdog_heartbeat_stale", CONNECTION_SYMBOL, ep.silentMs, heartbeatTracker.staleMs,
            config.feedKrakenHeartbeatKillEnabled, describe("heartbeat", ep))) return;
    }
    if (!heartbeatTracker.isStale(HEARTBEAT_KEY)) setFeedStale("kraken", "heartbeat", CONNECTION_SYMBOL, false);

    // 3. Per-symbol book.
    const symbols = activeSymbols.map((s) => s.ourSymbol);
    for (const ep of bookTracker.check(symbols, now)) {
        setFeedStale("kraken", "book", ep.key, true);
        if (killSocket("watchdog_book_stale", ep.key, ep.silentMs, bookTracker.staleMs,
            config.feedWatchdogKillEnabled, describe("book", ep))) return;
    }
    for (const symbol of symbols) {
        if (!bookTracker.isStale(symbol)) setFeedStale("kraken", "book", symbol, false);
    }

    // 4. Book checksum resyncs (only ever populated with enforcement on).
    checkBookResyncs(now);
}

/** e.g. "no book for SOL/USD for 10400ms", "no heartbeat within 11000ms of connect". */
function describe(channel: string, ep: StaleEpisode): string {
    const what = ep.key === HEARTBEAT_KEY ? channel : `${channel} for ${ep.key}`;
    return ep.seenSinceConnect
        ? `no ${what} for ${ep.silentMs}ms`
        : `no ${what} within ${ep.silentMs}ms of connect`;
}

/**
 * One stale episode. With `enabled` the socket is terminated and a reconnect
 * scheduled (returns true); otherwise only feed_watchdog_would_kill is logged.
 */
function killSocket(
    cause: ReconnectCause,
    symbol: string,
    silentMs: number,
    thresholdMs: number,
    enabled: boolean,
    detail: string,
): boolean {
    const action = enabled ? "kill" : "would_kill";
    recordWatchdogTrip("kraken", cause, symbol, action);
    logger.warn(
        { exchange: "kraken", cause, symbol, silentMs, thresholdMs, attempt: backoff.attempts },
        enabled ? "feed_watchdog_kill" : "feed_watchdog_would_kill",
    );
    if (!enabled || !ws) return false;
    dropSocket(ws, cause, detail);
    return true;
}

/**
 * Tear down `socket` for good and schedule exactly one reconnect. Listeners
 * are removed first so the old socket's late close/error events can never
 * schedule a second reconnect or touch the new socket's state; a no-op error
 * listener stays because terminate() on a CONNECTING socket emits one.
 */
function dropSocket(
    socket: WebSocket,
    cause: ReconnectCause,
    detail: string | null,
    closeCode?: number,
    closeReason?: string,
): void {
    if (ws !== socket) return;
    ws = null;
    wsConnected = false;
    bookTracker.disconnect();
    heartbeatTracker.disconnect();
    clearFeedStale("kraken");
    resetBookState();
    socket.removeAllListeners();
    socket.on("error", () => {});
    if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
    scheduleReconnect(cause, detail, closeCode, closeReason);
}

function scheduleReconnect(cause: ReconnectCause, detail: string | null, closeCode?: number, closeReason?: string): void {
    if (stopped) return;
    if (reconnectTimer) return;

    const combinedReconnectCount10m = recordKrakenReconnectAttempt();
    const budgetExceeded = isKrakenReconnectBudgetExceeded(combinedReconnectCount10m);
    const delay = backoff.nextDelay({ budgetExceeded });
    setReconnectBackoff("kraken", delay);
    recordFeedReconnect("kraken", cause, { closeCode, closeReason, detail });
    logger.info(
        { closeCode, closeReason, cause, detail, delay, attempt: backoff.attempts, combinedReconnectCount10m, budgetExceeded },
        "kraken_ws_reconnect_scheduled",
    );
    console.log(`[krakenWs] reconnecting in ${delay}ms (attempt ${backoff.attempts})`);
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
    }, delay);
}

export function startKrakenFeed(): void {
    if (!config.krakenWsEnabled) {
        logger.info("Kraken WS feed disabled via KRAKEN_WS_ENABLED=false");
        return;
    }
    stopped = false;
    connect();
}

export function stopKrakenFeed(): void {
    stopped = true;
    wsConnected = false;
    if (flushInterval) {
        clearInterval(flushInterval);
        flushInterval = null;
    }
    if (watchdogInterval) {
        clearInterval(watchdogInterval);
        watchdogInterval = null;
    }
    if (symbolRefreshInterval) {
        clearInterval(symbolRefreshInterval);
        symbolRefreshInterval = null;
    }
    flushDueCandles().catch((err: unknown) => {
        logger.error({ err }, "shutdown_flush_due_candles_failed");
    });
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    bookTracker.disconnect();
    heartbeatTracker.disconnect();
    clearFeedStale("kraken");
    resetBookState();
    if (ws) {
        ws.close();
        ws = null;
    }
}

/**
 * DEV-ONLY fault injection for the feed-staleness repro (routes/v1/
 * v1DebugFeedFault.ts, never registered in production). "close" terminates
 * the socket (exercises the reconnect path); "stall" stops reading from it
 * without closing (a half-open/silent stall — the heartbeat watchdog
 * notices within feedKrakenHeartbeatStaleMs, the 30s ticker net otherwise);
 * "resume" undoes a stall.
 */
export function __debugFaultKrakenSocket(mode: "close" | "stall" | "resume"): boolean {
    if (!ws) return false;
    if (mode === "close") ws.terminate();
    else if (mode === "stall") ws.pause();
    else ws.resume();
    return true;
}

/** TEST-ONLY — rebuild the trackers from current config and reset module state. */
export function __resetKrakenWsForTest(): void {
    stopKrakenFeed();
    lastTickAt = 0;
    socketOpenedAt = 0;
    activeSymbols = [];
    wsToOurSymbol = {};
    symbolToPairId = {};
    symbolsReady = false;
    formingSeedDone = false;
    precisions = new Map();
    resetBookState();
    bookTracker = new StalenessTracker({ staleMs: config.feedKrakenBookStaleMs, ...trackerOpts() });
    heartbeatTracker = new StalenessTracker({ staleMs: config.feedKrakenHeartbeatStaleMs, ...trackerOpts() });
    backoff = new ReconnectBackoff(KRAKEN_BACKOFF);
}
