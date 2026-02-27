import type { AppEvent } from "../events/eventTypes";
import type { BotRunState } from "./botTypes";
import { MAX_CONSECUTIVE_FAILURES } from "./botTypes";
import { subscribeGlobal, unsubscribe } from "../events/eventBus";
import type { EventHandler } from "../events/eventBus";
import { loadCandlesUpTo } from "./strategyAdaptor";
import { placeOrderWithSnapshot } from "../trading/phase6OrderService";
import * as repo from "./botRunRepo";
import { logger } from "../observability/logContext";

/* ── In-memory registry ───────────────────────── */

const registry = new Map<string, BotRunState>();

let handler: EventHandler | null = null;

/* ── Public API (called by strategyBotService) ── */

export function registerRun(state: BotRunState): void {
    registry.set(state.runId, state);
    logger.info({ runId: state.runId, pairId: state.pairId, mode: state.mode }, "Bot run registered");
}

export function deregisterRun(runId: string): void {
    registry.delete(runId);
    logger.info({ runId }, "Bot run deregistered");
}

export function pauseRunInRunner(runId: string): void {
    const state = registry.get(runId);
    if (state) state.paused = true;
}

export function resumeRunInRunner(runId: string): void {
    const state = registry.get(runId);
    if (state) state.paused = false;
}

/* ── Lifecycle ────────────────────────────────── */

export function initBotRunner(): void {
    if (handler) return; // already initialized

    handler = (event: AppEvent) => {
        if (event.type !== "replay.tick") return;

        const { pairId } = event.data;
        const tickTs = event.data.sessionTs;

        // Process all active runs for this pair (fire-and-forget, errors logged)
        for (const state of registry.values()) {
            if (state.pairId === pairId && !state.paused) {
                processRunTick(state, tickTs).catch((err) => {
                    logger.error({ runId: state.runId, err }, "Bot tick processing error");
                });
            }
        }
    };

    subscribeGlobal(handler);
    logger.info("Bot runner initialized");
}

export function shutdownBotRunner(): void {
    if (handler) {
        unsubscribe(handler);
        handler = null;
    }
    registry.clear();
    logger.info("Bot runner shut down");
}

/* ── Tick processing ──────────────────────────── */

async function processRunTick(state: BotRunState, tickTs: number): Promise<void> {
    // 1. Idempotency: skip already-processed ticks
    if (tickTs <= state.lastTickTs) return;

    // 2. Load latest candles at or before tickTs
    const [candles15m, candles4H, candles1D] = await Promise.all([
        loadCandlesUpTo(state.pairId, "15m", tickTs, 1),
        loadCandlesUpTo(state.pairId, "4H", tickTs, 1),
        loadCandlesUpTo(state.pairId, "1D", tickTs, 1),
    ]);

    if (candles15m.length === 0) return; // no data — skip

    const latest15m = candles15m[0];
    const latest4H = candles4H.length > 0 ? candles4H[0] : null;
    const latest1D = candles1D.length > 0 ? candles1D[0] : null;

    // 3. Feed higher timeframes only if they're new
    if (latest1D && latest1D.timestamp !== state.lastCandle1DTs) {
        state.engine.onDailyCandle(latest1D);
        state.lastCandle1DTs = latest1D.timestamp;
    }

    if (latest4H && latest4H.timestamp !== state.lastCandle4HTs) {
        state.engine.on4HCandle(latest4H);
        state.lastCandle4HTs = latest4H.timestamp;
    }

    // Only feed 15m if it's a new candle
    if (latest15m.timestamp !== state.lastCandle15mTs) {
        state.engine.onCandle(latest15m);
        state.lastCandle15mTs = latest15m.timestamp;
    } else {
        // Same candle, no new data to process
        state.lastTickTs = tickTs;
        await repo.updateRunStatus(state.runId, "RUNNING", { last_tick_ts: tickTs });
        return;
    }

    // 4. Flush events from engine
    const events = state.engine.flushEvents();
    state.orderSeqThisTick = 0;

    for (const evt of events) {
        // 5. Persist signal
        const signal = mapEngineEventToSignal(evt, tickTs);
        await repo.insertSignal(
            state.runId,
            signal.ts,
            signal.kind,
            signal.side,
            signal.confidence,
            signal.payload
        );

        // 6. Place orders for actionable events
        if (evt.type === "ENTRY") {
            const side = evt.signal.direction === "LONG" ? "BUY" as const : "SELL" as const;
            const qty = evt.position.positionSizeBtc.toString();
            const idemKey = `bot:${state.runId}:${tickTs}:${side}:${state.orderSeqThisTick}`;
            state.orderSeqThisTick++;

            try {
                await placeOrderWithSnapshot(
                    state.userId,
                    { pairId: state.pairId, side, type: "MARKET", qty },
                    idemKey
                );
                state.consecutiveFailures = 0;
            } catch (err) {
                state.consecutiveFailures++;
                logger.warn({ runId: state.runId, idemKey, err }, "Bot order placement failed");

                if (state.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                    await markRunFailed(state, err instanceof Error ? err.message : "order_placement_failed");
                    return;
                }
            }
        }

        if (evt.type === "EXIT") {
            const side = evt.log.direction === "LONG" ? "SELL" as const : "BUY" as const;
            const qty = evt.log.positionSizeBtc.toString();
            const idemKey = `bot:${state.runId}:${tickTs}:${side}:${state.orderSeqThisTick}`;
            state.orderSeqThisTick++;

            try {
                await placeOrderWithSnapshot(
                    state.userId,
                    { pairId: state.pairId, side, type: "MARKET", qty },
                    idemKey
                );
                state.consecutiveFailures = 0;
            } catch (err) {
                state.consecutiveFailures++;
                logger.warn({ runId: state.runId, idemKey, err }, "Bot exit order failed");

                if (state.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                    await markRunFailed(state, err instanceof Error ? err.message : "exit_order_failed");
                    return;
                }
            }
        }
    }

    // 7. Update last_tick_ts
    state.lastTickTs = tickTs;
    await repo.updateRunStatus(state.runId, "RUNNING", { last_tick_ts: tickTs });
}

/* ── Helpers ──────────────────────────────────── */

interface SignalData {
    ts: number;
    kind: string;
    side: string | null;
    confidence: string | null;
    payload: Record<string, unknown>;
}

type EngineEvent = ReturnType<typeof import("../strategy/engine").StrategyEngine.prototype.flushEvents>[number];

function mapEngineEventToSignal(evt: EngineEvent, tickTs: number): SignalData {
    switch (evt.type) {
        case "ENTRY":
            return {
                ts: tickTs,
                kind: "ENTRY",
                side: evt.signal.direction === "LONG" ? "BUY" : "SELL",
                confidence: null,
                payload: { signal: evt.signal, position: evt.position } as unknown as Record<string, unknown>,
            };
        case "EXIT":
            return {
                ts: tickTs,
                kind: "EXIT",
                side: evt.log.direction === "LONG" ? "SELL" : "BUY",
                confidence: null,
                payload: { log: evt.log } as unknown as Record<string, unknown>,
            };
        case "REGIME_CHANGE":
            return {
                ts: tickTs,
                kind: "REGIME_CHANGE",
                side: null,
                confidence: null,
                payload: { from: evt.from, to: evt.to },
            };
        case "SETUP_DETECTED":
            return {
                ts: tickTs,
                kind: "SETUP_DETECTED",
                side: null,
                confidence: null,
                payload: { setup: evt.setup } as unknown as Record<string, unknown>,
            };
        case "SETUP_INVALIDATED":
            return {
                ts: tickTs,
                kind: "SETUP_INVALIDATED",
                side: null,
                confidence: null,
                payload: { reason: evt.reason } as unknown as Record<string, unknown>,
            };
        default:
            return {
                ts: tickTs,
                kind: "REGIME_CHANGE",
                side: null,
                confidence: null,
                payload: evt as unknown as Record<string, unknown>,
            };
    }
}

async function markRunFailed(state: BotRunState, errorMessage: string): Promise<void> {
    deregisterRun(state.runId);
    await repo.updateRunStatus(state.runId, "FAILED", {
        stopped_at: new Date().toISOString(),
        error_message: errorMessage,
    });
    logger.error({ runId: state.runId, errorMessage }, "Bot run marked FAILED");
}
