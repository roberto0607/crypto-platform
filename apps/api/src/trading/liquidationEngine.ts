/**
 * Liquidation engine: watches open ISOLATED positions and acts on the ones
 * whose mark crossed their liq price. The rule, the queries and the rows are
 * in liquidation.ts; the close itself is an ordinary order through
 * placeOrderWithSnapshot.
 *
 * Design: docs/designs/2026-10-13-leverage-design.md §2.3.
 *
 * LIQUIDATION_MODE (config.leverage.liquidationMode):
 *   off       nothing runs: no subscription, no timer, no query.
 *   log_only  breaches are recorded as liquidations rows (LOG_ONLY, at most
 *             one per position episode) and logged (liquidation_would_fire).
 *             Positions and wallets are never touched.
 *   execute   a confirmed breach is closed with a MARKET order at the Kraken
 *             touch (placeOrderWithSnapshot, source 'liquidation'): margin
 *             released, P&L booked with the loss cap, taker fee capped at
 *             what's left, the remainder returned to the user, triggers
 *             canceled (#202), an EXECUTED row, a position.liquidated event
 *             and a bell notification.
 * Bots and @system.local users trade SPOT and are never liquidated.
 *
 * When: on price.tick for a pair (at most once every TICK_THROTTLE_MS per
 * pair), plus a sweep every SWEEP_MS that evaluates any tradable pair not
 * evaluated in that long (a dropped tick, or book updates with no ticks).
 * The tick handler only schedules: the evaluation runs on its own timer,
 * never inside the price-tick publish. One evaluation in flight per pair.
 * Each evaluation is one indexed query (liquidation.findLiquidationCandidates);
 * rows and orders follow only for positions that breach.
 *
 * Mark: the mid of the Kraken book (priceCollar.getCollarReference: ≤
 * MARKET_COLLAR_MAX_BOOK_AGE_MS old, not crossed) while krakenWs reports the
 * symbol ok. Anything else pauses the pair: no liquidation on a stale book,
 * the ticker or trading_pairs.last_price, ever. Breaches seen against the
 * stale book's mid during a pause are recorded as SKIPPED_STALE (once per
 * episode). On recovery the pair is evaluated at once; a position that gapped
 * through bankruptcy meanwhile closes at the touch and the loss cap absorbs it.
 *
 * Glitch guard: a position must breach on two consecutive evaluations at
 * least CONFIRM_MS apart before anything is written or traded, so one bad
 * book print can't liquidate anyone.
 *
 * Exactly once: the engine only proposes. The matching engine re-checks the
 * epoch, side, size and breach under the pair lock and the position row lock
 * and makes anything else a no-op (LiquidationNotNeeded); liquidations_once
 * is the backstop. So a second engine (two instances, leadership lost) or a
 * close racing the user's own close, a trigger or match end can't liquidate
 * twice or liquidate a closed position. Only the leader (LOCK_NAMES.liquidation)
 * evaluates, to avoid the wasted work.
 */
import { pool } from "../db/pool";
import { config } from "../config";
import Decimal from "decimal.js";
import { D, toFixed8 } from "../utils/decimal";
import { logger as rootLogger } from "../observability/logContext";
import { subscribeGlobal, unsubscribe, type EventHandler } from "../events/eventBus";
import { bookSnapshots } from "../market/orderFlowFeatures";
import { getKrakenWsHealth } from "../market/krakenWs";
import { isTradableSymbol } from "../market/marketSymbols";
import { tryAcquireLeadership, releaseLeadership, isLeader, LOCK_NAMES } from "../coordination/leaderElection";
import { notifyPositionLiquidated } from "../notifications/notificationService";
import { liquidationsTotal, liquidationPaused, liquidationEvalLag, liquidationEvalDuration } from "../metrics";
import { getCollarReference } from "./priceCollar";
import { isSystemUser } from "./buyingPower";
import { placeOrderWithSnapshot } from "./phase6OrderService";
import {
    findLiquidationCandidates,
    recordUnexecutedTx,
    closingSide,
    markOf,
    LiquidationNotNeeded,
    type LiquidationCandidate,
} from "./liquidation";

const logger = rootLogger.child({ module: "liquidationEngine" });

export const TICK_THROTTLE_MS = 250;
export const SWEEP_MS = 1_000;
export const CONFIRM_MS = 500;
/** After an unexpected error closing a position, wait this long before retrying it. */
export const FAILURE_BACKOFF_MS = 5_000;
const PAIR_REFRESH_MS = 60_000;
const LEADERSHIP_RETRY_MS = 5_000;

export type FeedStatus = "ok" | "stale" | "waiting" | "disconnected";

/** krakenWs's view of a symbol's book feed. */
export function krakenFeedStatus(symbol: string): FeedStatus {
    const health = getKrakenWsHealth();
    if (!health.connected) return "disconnected";
    return health.symbols[symbol]?.status ?? "waiting";
}

/** A liquidation the matching engine declined, or that match end beat: not a failure. */
const NOOP_ERRORS = new Set(["liquidation_not_needed", "match_ended", "stale_price_source"]);

export type PairEvaluation =
    | { status: "off" }
    | { status: "busy" }
    | { status: "paused"; feed: FeedStatus; skippedStale: number }
    | {
        status: "evaluated";
        mark: string;
        candidates: number;
        /** Breaching, waiting for the second confirmation. */
        pending: number;
        logged: number;
        executed: number;
        noop: number;
        failed: number;
    };

type PairState = {
    symbol: string;
    inFlight: boolean;
    lastEvalAt: number;
    timer: ReturnType<typeof setTimeout> | null;
    /** Glitch guard: position key → when it was first seen breaching (consecutively). */
    firstBreachAt: Map<string, number>;
    /** Keys already recorded this episode (LOG_ONLY / SKIPPED_STALE), to skip the no-op insert. */
    recorded: Set<string>;
    /** Key → no retry before this time (after an unexpected error). */
    retryAfter: Map<string, number>;
    pausedSince: number | null;
};

const keyOf = (c: Pick<LiquidationCandidate, "userId" | "scope" | "epoch">) =>
    `${c.userId}:${c.scope.competitionId ?? ""}:${c.scope.matchId ?? ""}:${c.epoch}`;

export type LiquidationEngineOptions = {
    feedStatus?: (symbol: string) => FeedStatus;
    /** Evaluate only while holding LOCK_NAMES.liquidation (the running server). Tests pass false. */
    useLeadership?: boolean;
};

export class LiquidationEngine {
    private readonly pairs = new Map<string, PairState>();
    private readonly feedStatus: (symbol: string) => FeedStatus;
    private readonly useLeadership: boolean;
    private handler: EventHandler | null = null;
    private sweepTimer: ReturnType<typeof setInterval> | null = null;
    private sweeping = false;
    private pairsLoadedAt = 0;
    private nextLeadershipAttempt = 0;
    private stopped = false;

    constructor(opts: LiquidationEngineOptions = {}) {
        this.feedStatus = opts.feedStatus ?? krakenFeedStatus;
        this.useLeadership = opts.useLeadership ?? true;
    }

    /** Subscribe to price.tick and start the sweep. A no-op while LIQUIDATION_MODE=off. */
    start(): void {
        if (this.handler || config.leverage.liquidationMode === "off") return;
        this.stopped = false;
        this.handler = (event) => {
            if (event.type === "price.tick") this.onTick(event.data.pairId, event.data.symbol);
        };
        subscribeGlobal(this.handler);
        this.sweepTimer = setInterval(() => {
            this.sweep().catch((err) => logger.error({ err }, "liquidation_sweep_error"));
        }, SWEEP_MS);
        this.sweepTimer.unref();
        logger.info({ mode: config.leverage.liquidationMode }, "Liquidation engine started");
    }

    async stop(): Promise<void> {
        this.stopped = true;
        if (this.handler) unsubscribe(this.handler);
        this.handler = null;
        if (this.sweepTimer) clearInterval(this.sweepTimer);
        this.sweepTimer = null;
        for (const st of this.pairs.values()) {
            if (st.timer) clearTimeout(st.timer);
            st.timer = null;
        }
        if (this.useLeadership) await releaseLeadership(pool, LOCK_NAMES.liquidation);
    }

    private active(): boolean {
        return !this.stopped && (!this.useLeadership || isLeader(LOCK_NAMES.liquidation));
    }

    private state(pairId: string, symbol: string): PairState {
        let st = this.pairs.get(pairId);
        if (!st) {
            st = {
                symbol, inFlight: false, lastEvalAt: 0, timer: null,
                firstBreachAt: new Map(), recorded: new Set(), retryAfter: new Map(), pausedSince: null,
            };
            this.pairs.set(pairId, st);
        }
        return st;
    }

    /** price.tick: schedule an evaluation (throttled), never run it inline. */
    private onTick(pairId: string, symbol: string): void {
        if (!this.active() || !isTradableSymbol(symbol)) return;
        const st = this.state(pairId, symbol);
        if (st.timer) return; // one already scheduled will see this price
        const now = Date.now();
        const dueAt = Math.max(now, st.lastEvalAt + TICK_THROTTLE_MS);
        st.timer = setTimeout(() => {
            st.timer = null;
            this.run(pairId, dueAt);
        }, dueAt - now);
        st.timer.unref?.();
    }

    private run(pairId: string, dueAt: number): void {
        liquidationEvalLag.observe(Math.max(0, Date.now() - dueAt));
        this.evaluatePair(pairId).catch((err) => logger.error({ err, pairId }, "liquidation_eval_error"));
    }

    /** Every SWEEP_MS: leadership, then any pair not evaluated in that long. */
    private async sweep(): Promise<void> {
        if (this.sweeping || this.stopped) return;
        this.sweeping = true;
        try {
            const now = Date.now();
            if (this.useLeadership && !isLeader(LOCK_NAMES.liquidation)) {
                if (now < this.nextLeadershipAttempt) return;
                this.nextLeadershipAttempt = now + LEADERSHIP_RETRY_MS;
                if (!(await tryAcquireLeadership(pool, LOCK_NAMES.liquidation))) return;
            }
            if (now - this.pairsLoadedAt >= PAIR_REFRESH_MS) await this.loadPairs();
            for (const [pairId, st] of this.pairs) {
                if (st.inFlight || st.timer || now - st.lastEvalAt < SWEEP_MS) continue;
                this.run(pairId, now);
            }
        } finally {
            this.sweeping = false;
        }
    }

    private async loadPairs(): Promise<void> {
        const { rows } = await pool.query<{ id: string; symbol: string }>(
            `SELECT id, symbol FROM trading_pairs WHERE is_active = true`,
        );
        for (const r of rows) if (isTradableSymbol(r.symbol)) this.state(r.id, r.symbol);
        this.pairsLoadedAt = Date.now();
    }

    /** Pause/resume bookkeeping for a pair whose feed is (not) trustworthy. */
    private pause(pairId: string, st: PairState, feed: FeedStatus, now: number): void {
        st.firstBreachAt.clear(); // a confirmation never spans a pause
        if (st.pausedSince !== null) return;
        st.pausedSince = now;
        const book = bookSnapshots.get(pairId);
        liquidationPaused.set({ pair: st.symbol }, 1);
        logger.warn(
            { pairId, symbol: st.symbol, feed, bookAgeMs: book ? now - book.ts : null },
            "liquidation_paused_stale_feed",
        );
    }

    private resume(pairId: string, st: PairState, now: number): void {
        if (st.pausedSince === null) return;
        liquidationPaused.set({ pair: st.symbol }, 0);
        logger.info({ pairId, symbol: st.symbol, pausedMs: now - st.pausedSince }, "liquidation_resumed");
        st.pausedSince = null;
    }

    /**
     * Evaluate one pair now. Exposed for tests and the sweep; `now` drives the
     * book age and the glitch guard.
     */
    async evaluatePair(pairId: string, now: number = Date.now()): Promise<PairEvaluation> {
        const mode = config.leverage.liquidationMode;
        if (mode === "off") return { status: "off" };

        let st = this.pairs.get(pairId);
        if (!st) {
            const { rows } = await pool.query<{ symbol: string }>(`SELECT symbol FROM trading_pairs WHERE id = $1`, [pairId]);
            if (!rows[0]) return { status: "off" };
            st = this.state(pairId, rows[0].symbol);
        }
        if (st.inFlight) return { status: "busy" };
        st.inFlight = true;
        st.lastEvalAt = now;
        const started = performance.now();
        try {
            const feed = this.feedStatus(st.symbol);
            const ref = feed === "ok" ? getCollarReference(pairId, now) : null;
            if (!ref) {
                this.pause(pairId, st, feed, now);
                return { status: "paused", feed, skippedStale: await this.recordStale(pairId, st, now) };
            }
            this.resume(pairId, st, now);

            const mark = markOf(ref);
            const candidates = await findLiquidationCandidates(pool, pairId, mark);
            const result = { status: "evaluated" as const, mark: toFixed8(mark), candidates: candidates.length,
                pending: 0, logged: 0, executed: 0, noop: 0, failed: 0 };

            const seen = new Set<string>();
            const confirmed: LiquidationCandidate[] = [];
            for (const c of candidates) {
                if (await isSystemUser(c.userId)) continue;
                const key = keyOf(c);
                seen.add(key);
                const first = st.firstBreachAt.get(key);
                if (first === undefined) st.firstBreachAt.set(key, now);
                if (first === undefined || now - first < CONFIRM_MS) {
                    result.pending++;
                    continue;
                }
                confirmed.push(c);
            }
            // Consecutive: a position that stopped breaching starts over.
            for (const key of st.firstBreachAt.keys()) if (!seen.has(key)) st.firstBreachAt.delete(key);
            for (const key of st.recorded) if (!seen.has(key)) st.recorded.delete(key);

            for (const c of confirmed) {
                const key = keyOf(c);
                if (mode === "log_only") {
                    if (st.recorded.has(key)) continue;
                    const row = await recordUnexecutedTx(pool, "LOG_ONLY", c, mark, Math.round(ref.ageMs));
                    st.recorded.add(key);
                    if (!row) continue;
                    result.logged++;
                    liquidationsTotal.inc({ mode: "LOG_ONLY" });
                    logger.warn({
                        userId: c.userId, pairId, symbol: st.symbol, scope: c.scope, epoch: c.epoch, side: c.side,
                        qty: row.qty, entry: row.entry, leverage: row.leverage, margin: row.margin,
                        liqPrice: row.liqPrice, mark: toFixed8(mark), bid: ref.bestBid.toString(),
                        ask: ref.bestAsk.toString(), bookAgeMs: Math.round(ref.ageMs),
                    }, "liquidation_would_fire");
                    continue;
                }

                const retryAt = st.retryAfter.get(key);
                if (retryAt !== undefined && now < retryAt) continue;
                const outcome = await this.execute(c, st.symbol);
                if (outcome === "failed") st.retryAfter.set(key, now + FAILURE_BACKOFF_MS);
                else st.retryAfter.delete(key);
                result[outcome]++;
            }
            return result;
        } finally {
            st.inFlight = false;
            liquidationEvalDuration.observe(performance.now() - started);
        }
    }

    /**
     * A paused pair: record (once per episode) the positions that breach
     * against the stale book's mid, as SKIPPED_STALE. Indicative only; nothing
     * is traded on it. No book at all: nothing to compare with.
     */
    private async recordStale(pairId: string, st: PairState, now: number): Promise<number> {
        const book = bookSnapshots.get(pairId);
        const bid = book?.bids[0]?.price;
        const ask = book?.asks[0]?.price;
        if (!book || !(bid! > 0) || !(ask! > 0) || bid! > ask!) return 0;
        const staleMark = markOf({ bestBid: D(String(bid)), bestAsk: D(String(ask)) });
        let written = 0;
        for (const c of await findLiquidationCandidates(pool, pairId, staleMark)) {
            const key = `stale:${keyOf(c)}`;
            if (st.recorded.has(key) || (await isSystemUser(c.userId))) continue;
            const row = await recordUnexecutedTx(pool, "SKIPPED_STALE", c, staleMark, now - book.ts);
            st.recorded.add(key);
            if (!row) continue;
            written++;
            liquidationsTotal.inc({ mode: "SKIPPED_STALE" });
            logger.warn({
                userId: c.userId, pairId, symbol: st.symbol, scope: c.scope, epoch: c.epoch, side: c.side,
                liqPrice: row.liqPrice, staleMark: toFixed8(staleMark), bookAgeMs: now - book.ts,
            }, "liquidation_skipped_stale");
        }
        return written;
    }

    /** Close one confirmed position through the order pipeline. */
    private async execute(c: LiquidationCandidate, symbol: string): Promise<"executed" | "noop" | "failed"> {
        const ctx = { userId: c.userId, pairId: c.pairId, scope: c.scope, epoch: c.epoch, side: c.side };
        try {
            const res = await placeOrderWithSnapshot(
                c.userId,
                { pairId: c.pairId, side: closingSide(c.side), type: "MARKET", qty: toFixed8(c.qty) },
                undefined,
                undefined,
                c.scope.competitionId,
                c.scope.matchId,
                "liquidation",
                { epoch: c.epoch, side: c.side },
            );
            const l = res.liquidation;
            if (!l) throw new Error("liquidation_result_missing");
            liquidationsTotal.inc({ mode: "EXECUTED" });
            logger.warn({
                ...ctx, liquidationId: l.liquidationId, orderId: res.order.id, qty: l.qty, entry: l.entry,
                leverage: l.leverage, margin: l.margin, liqPrice: l.liqPrice, mark: l.mark, fillPrice: l.fillPrice,
                realizedPnl: l.realizedPnl, fee: l.fee, returnedEquity: l.returnedEquity, shortfall: l.shortfall,
                bookAgeMs: l.bookAgeMs,
            }, "liquidation_executed");
            if (new Decimal(l.shortfall).gt(0)) {
                logger.warn({ ...ctx, liquidationId: l.liquidationId, shortfall: l.shortfall }, "liquidation_shortfall_absorbed");
            }
            await notifyPositionLiquidated(c.userId, symbol, {
                side: l.side, leverage: l.leverage, fillPrice: l.fillPrice, returnedEquity: l.returnedEquity,
                matchId: l.scope.matchId,
            });
            return "executed";
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            const code = (err as { code?: string; constraint?: string } | null);
            if (NOOP_ERRORS.has(message) || (code?.code === "23505" && code.constraint === "liquidations_once")) {
                logger.info({ ...ctx, reason: err instanceof LiquidationNotNeeded ? err.reason : message }, "liquidation_noop");
                return "noop";
            }
            logger.error({ ...ctx, err }, "liquidation_execute_error");
            return "failed";
        }
    }
}

let engine: LiquidationEngine | null = null;

/** Start the process's engine (server.ts). Evaluates only while it holds LOCK_NAMES.liquidation. */
export function startLiquidationEngine(): void {
    if (config.leverage.liquidationMode === "off") {
        logger.info("Liquidation engine off (LIQUIDATION_MODE=off)");
        return;
    }
    if (engine) return;
    engine = new LiquidationEngine();
    engine.start();
}

export async function stopLiquidationEngine(): Promise<void> {
    if (!engine) return;
    const e = engine;
    engine = null;
    await e.stop();
    logger.info("Liquidation engine stopped");
}
