import type { StrategyParams } from "../strategy/backtestTypes";
import type { StrategyEngine } from "../strategy/engine";

/* ── DB row types ─────────────────────────────── */

export interface StrategyRunRow {
    id: string;
    user_id: string;
    pair_id: string;
    mode: "REPLAY" | "LIVE";
    status: "RUNNING" | "PAUSED" | "STOPPED" | "COMPLETED" | "FAILED";
    started_at: string;
    stopped_at: string | null;
    last_tick_ts: number | null;
    params_json: StrategyParams;
    error_message: string | null;
    created_at: string;
    updated_at: string;
}

export interface StrategySignalRow {
    id: string;
    run_id: string;
    ts: number;
    kind: "ENTRY" | "EXIT" | "REGIME_CHANGE" | "SETUP_DETECTED" | "SETUP_INVALIDATED";
    side: "BUY" | "SELL" | null;
    confidence: string | null;
    payload_json: Record<string, unknown>;
    created_at: string;
}

/* ── In-memory state for active runs ──────────── */

export interface BotRunState {
    runId: string;
    userId: string;
    pairId: string;
    mode: "REPLAY" | "LIVE";
    engine: StrategyEngine;
    lastTickTs: number;
    lastCandle15mTs: string;
    lastCandle4HTs: string;
    lastCandle1DTs: string;
    orderSeqThisTick: number;
    consecutiveFailures: number;
    paused: boolean;
}

/* ── Bot decision ─────────────────────────────── */

export type BotDecision =
    | { action: "NONE" }
    | { action: "PLACE_ORDER"; side: "BUY" | "SELL"; qty: string; type: "MARKET" | "LIMIT"; limitPrice?: string }
    | { action: "CLOSE_POSITION"; side: "BUY" | "SELL"; qty: string };

/* ── Constants ────────────────────────────────── */

export const MAX_CONSECUTIVE_FAILURES = 3;
