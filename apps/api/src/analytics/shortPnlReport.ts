/**
 * Short P&L report (read-only).
 *
 * Until the applyFill fix, the positions row got shorts wrong: covering a
 * short realized no P&L, adding to a short reset the entry to the last fill,
 * and a short → long flip realized nothing and mispriced the long. base_qty
 * was always right.
 *
 * This replays every position scope (user, pair, competition, match) from
 * its fills with the fixed math and compares the result with the stored row:
 *   - per position: stored vs correct realized P&L, and the entry of a
 *     position that is still open;
 *   - per ended match: each player's stored P&L% and score vs what the
 *     correct rows give, and whether the winner would change.
 * It changes nothing.
 *
 * Not affected, so not reported: wallet balances and the ledger, equity
 * (cash + qty × mark), weekly-competition leaderboards (ranked on that
 * equity), and the closed_trades journal (its own FIFO lots, which handle
 * shorts correctly).
 *
 * A scope whose replayed qty differs from the stored base_qty has fills the
 * replay can't see (older data, e.g. match orders stamped match_id = NULL
 * before PR #26). Its numbers are shown but flagged unreliable and left out
 * of the totals.
 *
 * Known approximation: fills of one order share executed_at, so a flip
 * inside a single multi-fill order may replay its fills in a different order
 * than they executed (ties broken by trade id). Totals are unaffected unless
 * that order both closed and reopened the position.
 */
import type { Pool, PoolClient } from "pg";
import Decimal from "decimal.js";
import { D, ZERO, toFixed8 } from "../utils/decimal";
import { applyFill, type PositionState } from "./positionMath";
import { playerStatsFromRows } from "../competitions/matchService";

/** A realized P&L difference below this (in quote) is rounding, not the bug. */
const EPS = D("0.01");

export type ScopeFill = {
    user_id: string;
    pair_id: string;
    competition_id: string | null;
    match_id: string | null;
    side: "BUY" | "SELL";
    qty: string;
    price: string;
};

export type StoredPosition = {
    user_id: string;
    pair_id: string;
    competition_id: string | null;
    match_id: string | null;
    base_qty: string;
    avg_entry_price: string;
    realized_pnl_quote: string;
    fees_paid_quote: string;
};

export type ReportMatch = {
    id: string;
    status: string;
    completed_at: string | null;
    starting_capital: string;
    challenger_id: string;
    opponent_id: string;
    challenger_pnl_pct: string | null;
    opponent_pnl_pct: string | null;
    challenger_trades_count: number | null;
    opponent_trades_count: number | null;
    challenger_score: string | null;
    opponent_score: string | null;
    winner_id: string | null;
};

export type PositionFinding = {
    user_id: string;
    pair_id: string;
    competition_id: string | null;
    match_id: string | null;
    fills: number;
    base_qty: string;
    stored_realized: string;
    correct_realized: string;
    /** correct − stored */
    delta_realized: string;
    /** Entry of an open position; null when flat. */
    stored_entry: string | null;
    correct_entry: string | null;
    /** Replayed qty == stored base_qty. */
    reliable: boolean;
};

export type MatchPlayerFinding = {
    user_id: string;
    stored_pnl_pct: string | null;
    correct_pnl_pct: string;
    stored_score: string | null;
    correct_score: string;
};

export type MatchFinding = {
    match_id: string;
    status: string;
    completed_at: string | null;
    challenger: MatchPlayerFinding;
    opponent: MatchPlayerFinding;
    stored_winner_id: string | null;
    /** By score for COMPLETED; a forfeit's winner is set by the rule, not the score. */
    correct_winner_id: string | null;
    winner_changes: boolean;
    /** A row of this match is unreliable (see PositionFinding.reliable). */
    reliable: boolean;
};

export function scopeKey(r: { user_id: string; pair_id: string; competition_id: string | null; match_id: string | null }): string {
    return `${r.user_id}:${r.pair_id}:${r.competition_id ?? ""}:${r.match_id ?? ""}`;
}

/** Replay fills (already in execution order) per scope with the fixed math. */
export function replayScopes(fills: ScopeFill[]): Map<string, PositionState & { fills: number }> {
    const out = new Map<string, PositionState & { fills: number }>();
    for (const f of fills) {
        const key = scopeKey(f);
        const prev = out.get(key) ?? { qty: ZERO, avgEntry: ZERO, realizedPnl: ZERO, fills: 0 };
        const next = applyFill(prev, f.side, D(f.qty), D(f.price));
        out.set(key, { ...next, fills: prev.fills + 1 });
    }
    return out;
}

/**
 * Positions whose stored row disagrees with the replay: realized P&L off by
 * ≥ EPS, or an open position's entry differs. Rows with no fills are skipped.
 */
export function comparePositions(
    stored: StoredPosition[],
    replayed: Map<string, PositionState & { fills: number }>,
): PositionFinding[] {
    const findings: PositionFinding[] = [];
    for (const row of stored) {
        const r = replayed.get(scopeKey(row));
        if (!r) continue;

        const storedQty = D(row.base_qty);
        const deltaRealized = r.realizedPnl.minus(D(row.realized_pnl_quote));
        const open = !storedQty.isZero();
        const entryDiffers = open && !r.avgEntry.minus(D(row.avg_entry_price)).abs().lt(D("0.00000001"));
        if (deltaRealized.abs().lt(EPS) && !entryDiffers) continue;

        findings.push({
            user_id: row.user_id,
            pair_id: row.pair_id,
            competition_id: row.competition_id,
            match_id: row.match_id,
            fills: r.fills,
            base_qty: toFixed8(storedQty),
            stored_realized: toFixed8(D(row.realized_pnl_quote)),
            correct_realized: toFixed8(r.realizedPnl),
            delta_realized: toFixed8(deltaRealized),
            stored_entry: open ? toFixed8(D(row.avg_entry_price)) : null,
            correct_entry: open ? toFixed8(r.avgEntry) : null,
            reliable: r.qty.eq(storedQty),
        });
    }
    return findings;
}

function fmt(n: number): string {
    return n.toFixed(4);
}

/**
 * Ended matches (COMPLETED / FORFEITED) with at least one affected row:
 * each player's P&L% and score from the stored rows vs from the corrected
 * rows (same formula as match end: playerStatsFromRows), and whether the
 * winner would change. Trades count is the stored one (unaffected).
 */
export function compareMatches(
    matches: ReportMatch[],
    stored: StoredPosition[],
    findings: PositionFinding[],
): MatchFinding[] {
    const fixedByKey = new Map(findings.map((f) => [scopeKey(f), f]));
    const out: MatchFinding[] = [];

    for (const m of matches) {
        if (m.status !== "COMPLETED" && m.status !== "FORFEITED") continue;
        const rows = stored.filter((p) => p.match_id === m.id);
        const affected = rows.filter((p) => fixedByKey.has(scopeKey(p)));
        if (affected.length === 0) continue;

        const capital = parseFloat(m.starting_capital);
        const player = (userId: string, storedPct: string | null, storedScore: string | null, trades: number | null): MatchPlayerFinding => {
            const corrected = rows
                .filter((p) => p.user_id === userId)
                .map((p) => {
                    const f = fixedByKey.get(scopeKey(p));
                    return { realized_pnl_quote: f ? f.correct_realized : p.realized_pnl_quote, fees_paid_quote: p.fees_paid_quote };
                });
            const stats = playerStatsFromRows(corrected, capital, trades ?? 0);
            return {
                user_id: userId,
                stored_pnl_pct: storedPct,
                correct_pnl_pct: fmt(stats.pnlPct),
                stored_score: storedScore,
                correct_score: fmt(stats.score),
            };
        };

        const challenger = player(m.challenger_id, m.challenger_pnl_pct, m.challenger_score, m.challenger_trades_count);
        const opponent = player(m.opponent_id, m.opponent_pnl_pct, m.opponent_score, m.opponent_trades_count);

        let correctWinner = m.winner_id;
        if (m.status === "COMPLETED") {
            const c = Number(challenger.correct_score);
            const o = Number(opponent.correct_score);
            correctWinner = c > o ? m.challenger_id : o > c ? m.opponent_id : null;
        }

        out.push({
            match_id: m.id,
            status: m.status,
            completed_at: m.completed_at,
            challenger,
            opponent,
            stored_winner_id: m.winner_id,
            correct_winner_id: correctWinner,
            winner_changes: correctWinner !== m.winner_id,
            reliable: affected.every((p) => fixedByKey.get(scopeKey(p))!.reliable),
        });
    }
    return out;
}

/** Σ delta_realized over reliable findings. */
export function totalDelta(findings: PositionFinding[]): string {
    return toFixed8(findings.filter((f) => f.reliable).reduce((s: Decimal, f) => s.plus(D(f.delta_realized)), ZERO));
}

// ── Loaders (read-only queries) ──

/** Every user fill with its order's scope, in execution order per scope. */
export async function loadScopeFills(db: Pool | PoolClient, userId: string | null): Promise<ScopeFill[]> {
    // Two joins (buy side, sell side) rather than ON ... IN (...) so each
    // uses its order-id index. A user is never on both sides of one trade
    // (self-trade prevention), so no fill is counted twice.
    const { rows } = await db.query<ScopeFill>(
        `SELECT user_id, pair_id, competition_id, match_id, side, qty, price FROM (
             SELECT o.user_id, t.pair_id, o.competition_id, o.match_id, o.side,
                    t.qty::text AS qty, t.price::text AS price, t.executed_at, t.id
             FROM trades t JOIN orders o ON o.id = t.buy_order_id
             WHERE ($1::uuid IS NULL OR o.user_id = $1)
             UNION ALL
             SELECT o.user_id, t.pair_id, o.competition_id, o.match_id, o.side,
                    t.qty::text, t.price::text, t.executed_at, t.id
             FROM trades t JOIN orders o ON o.id = t.sell_order_id
             WHERE ($1::uuid IS NULL OR o.user_id = $1)
         ) f
         ORDER BY executed_at, id`,
        [userId],
    );
    return rows;
}

export async function loadStoredPositions(db: Pool | PoolClient, userId: string | null): Promise<StoredPosition[]> {
    const { rows } = await db.query<StoredPosition>(
        `SELECT user_id, pair_id, competition_id, match_id,
                base_qty::text, avg_entry_price::text, realized_pnl_quote::text, fees_paid_quote::text
         FROM positions
         WHERE ($1::uuid IS NULL OR user_id = $1)`,
        [userId],
    );
    return rows;
}

export async function loadEndedMatches(db: Pool | PoolClient): Promise<ReportMatch[]> {
    const { rows } = await db.query<ReportMatch>(
        `SELECT id, status, completed_at::text, starting_capital::text,
                challenger_id, opponent_id,
                challenger_pnl_pct::text, opponent_pnl_pct::text,
                challenger_trades_count, opponent_trades_count,
                challenger_score::text, opponent_score::text, winner_id
         FROM matches
         WHERE status IN ('COMPLETED', 'FORFEITED')
         ORDER BY completed_at NULLS LAST, id`,
    );
    return rows;
}
