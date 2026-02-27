import type { StrategyParams } from "../strategy/backtestTypes";
import { DEFAULT_PARAMS } from "../strategy/backtestTypes";
import { StrategyEngine } from "../strategy/engine";
import type { StrategyRunRow, StrategySignalRow, BotRunState } from "./botTypes";
import { MAX_CONSECUTIVE_FAILURES } from "./botTypes";
import * as repo from "./botRunRepo";
import { loadWarmupCandles } from "./strategyAdaptor";
import { registerRun, deregisterRun, pauseRunInRunner, resumeRunInRunner } from "./botRunner";
import { listWalletsByUserId } from "../wallets/walletRepo";
import { decodeCursor, parseLimit, slicePage } from "../http/pagination";
import { getSession } from "../replay/replayRepo";
import { AppError } from "../errors/AppError";

/* ── Helpers ──────────────────────────────────── */

async function estimateEquity(userId: string): Promise<number> {
    const wallets = await listWalletsByUserId(userId);
    // Sum all USD-like balances as a rough equity estimate
    // In a real system this would mark-to-market all positions
    let total = 0;
    for (const w of wallets) {
        if (w.symbol === "USD" || w.symbol === "USDT" || w.symbol === "USDC") {
            total += parseFloat(w.balance);
        }
    }
    return total || 10000; // fallback for paper trading
}

function mergeParams(partial?: Partial<StrategyParams>): StrategyParams {
    return { ...DEFAULT_PARAMS, ...partial };
}

/* ── Service functions ────────────────────────── */

export async function startRun(
    userId: string,
    pairId: string,
    mode: "REPLAY" | "LIVE",
    params?: Partial<StrategyParams>
): Promise<StrategyRunRow> {
    // Validate: if REPLAY mode, an active replay session must exist
    if (mode === "REPLAY") {
        const session = await getSession(userId, pairId);
        if (!session || !session.is_active) {
            throw new AppError("no_active_replay", {
                message: "Start a replay session before launching a REPLAY bot run",
            });
        }
    }

    const merged = mergeParams(params);
    const accountEquity = await estimateEquity(userId);

    // Persist the run
    const row = await repo.insertRun(userId, pairId, mode, merged);

    // Load warmup candles and bootstrap engine
    const startTs = Date.now();
    const warmup = await loadWarmupCandles(pairId, startTs);

    const engine = new StrategyEngine({ accountEquity, params: merged });

    // Feed warmup candles (1D first, then 4H, then 15m)
    for (const c of warmup.candles1D) engine.onDailyCandle(c);
    for (const c of warmup.candles4H) engine.on4HCandle(c);
    for (const c of warmup.candles15m) engine.onCandle(c);

    // Drain warmup events (discard — they're historical)
    engine.flushEvents();

    const state: BotRunState = {
        runId: row.id,
        userId,
        pairId,
        mode,
        engine,
        lastTickTs: 0,
        lastCandle15mTs: "",
        lastCandle4HTs: "",
        lastCandle1DTs: "",
        orderSeqThisTick: 0,
        consecutiveFailures: 0,
        paused: false,
    };

    registerRun(state);
    return row;
}

export async function pauseRun(
    userId: string,
    runId: string
): Promise<StrategyRunRow> {
    const row = await repo.getRunByIdForUser(userId, runId);
    if (!row) throw new AppError("run_not_found", { runId });
    if (row.status !== "RUNNING") throw new AppError("run_not_running", { status: row.status });

    pauseRunInRunner(runId);
    const updated = await repo.updateRunStatus(runId, "PAUSED");
    return updated!;
}

export async function resumeRun(
    userId: string,
    runId: string
): Promise<StrategyRunRow> {
    const row = await repo.getRunByIdForUser(userId, runId);
    if (!row) throw new AppError("run_not_found", { runId });
    if (row.status !== "PAUSED") throw new AppError("run_not_paused", { status: row.status });

    resumeRunInRunner(runId);
    const updated = await repo.updateRunStatus(runId, "RUNNING");
    return updated!;
}

export async function stopRun(
    userId: string,
    runId: string
): Promise<StrategyRunRow> {
    const row = await repo.getRunByIdForUser(userId, runId);
    if (!row) throw new AppError("run_not_found", { runId });
    if (row.status !== "RUNNING" && row.status !== "PAUSED") {
        throw new AppError("run_not_active", { status: row.status });
    }

    deregisterRun(runId);
    const updated = await repo.updateRunStatus(runId, "STOPPED", {
        stopped_at: new Date().toISOString(),
    });
    return updated!;
}

export async function getRun(
    userId: string,
    runId: string
): Promise<StrategyRunRow> {
    const row = await repo.getRunByIdForUser(userId, runId);
    if (!row) throw new AppError("run_not_found", { runId });
    return row;
}

export async function listRuns(
    userId: string,
    cursorRaw?: string,
    limitRaw?: unknown
): Promise<{ data: StrategyRunRow[]; nextCursor: string | null }> {
    const limit = parseLimit(limitRaw);
    const cursor = decodeCursor<{ ca: string; id: string }>(cursorRaw);
    const rows = await repo.listRunsByUser(userId, limit, cursor);
    return slicePage(rows, limit, (r) => ({ ca: r.created_at, id: r.id }));
}

export async function listSignals(
    userId: string,
    runId: string,
    cursorRaw?: string,
    limitRaw?: unknown
): Promise<{ data: StrategySignalRow[]; nextCursor: string | null }> {
    // Ownership check
    const row = await repo.getRunByIdForUser(userId, runId);
    if (!row) throw new AppError("run_not_found", { runId });

    const limit = parseLimit(limitRaw);
    const cursor = decodeCursor<{ ts: number; id: string }>(cursorRaw);
    const rows = await repo.listSignalsByRun(runId, limit, cursor);
    return slicePage(rows, limit, (r) => ({ ts: r.ts, id: r.id }));
}
