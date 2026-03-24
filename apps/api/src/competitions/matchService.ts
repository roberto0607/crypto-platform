import type { PoolClient } from "pg";
import { pool, acquireClient } from "../db/pool.js";
import { resolveMatchElo, type TWTier } from "./eloService.js";
import { getUserTier } from "./tierRepo.js";
import { getSnapshot } from "../market/snapshotStore.js";
import { logger as rootLogger } from "../observability/logContext.js";
import { publish } from "../events/eventBus.js";
import { createEvent } from "../events/eventTypes.js";

const logger = rootLogger.child({ module: "matchService" });

// ── Types ──

export interface MatchRow {
    id: string;
    season_id: string | null;
    challenger_id: string;
    opponent_id: string;
    status: "PENDING" | "ACTIVE" | "COMPLETED" | "FORFEITED" | "EXPIRED";
    duration_hours: number;
    starting_capital: string;
    challenger_pnl_pct: string | null;
    opponent_pnl_pct: string | null;
    challenger_trades_count: number;
    opponent_trades_count: number;
    challenger_win_rate: string | null;
    opponent_win_rate: string | null;
    challenger_score: string | null;
    opponent_score: string | null;
    winner_id: string | null;
    forfeit_user_id: string | null;
    elo_delta: number | null;
    started_at: string | null;
    ends_at: string | null;
    completed_at: string | null;
    created_at: string;
}

export interface MatchWithPlayers extends MatchRow {
    challenger_name: string | null;
    challenger_elo: number;
    opponent_name: string | null;
    opponent_elo: number;
}

/** Starting capital per tier */
const TIER_CAPITAL: Record<TWTier, number> = {
    ROOKIE: 50_000,
    PRO:    100_000,
    ELITE:  250_000,
    LEGEND: 1_000_000,
};

/** Minimum trades required for a valid match result */
const MIN_MATCH_TRADES = 3;

// ── Queries ──

/**
 * Create a new match challenge.
 * Validates no active match exists for either player.
 */
export async function createMatch(
    challengerId: string,
    opponentId: string,
    durationHours: number,
    allowedPairIds: string[],
): Promise<MatchRow> {
    if (challengerId === opponentId) throw new Error("invalid_input");

    const client = await acquireClient();
    try {
        await client.query("BEGIN");

        // Check neither player has an active match
        const { rows: active } = await client.query(
            `SELECT id FROM matches
             WHERE status IN ('PENDING', 'ACTIVE')
               AND (challenger_id = ANY($1) OR opponent_id = ANY($1))
             LIMIT 1`,
            [[challengerId, opponentId]],
        );
        if (active.length > 0) throw new Error("match_already_active");

        // Determine tier from challenger for capital
        const tierRaw = await getUserTier(challengerId);
        const tier = (["ROOKIE", "PRO", "ELITE", "LEGEND"].includes(tierRaw) ? tierRaw : "ROOKIE") as TWTier;
        const capital = TIER_CAPITAL[tier];

        const { rows } = await client.query<MatchRow>(
            `INSERT INTO matches (challenger_id, opponent_id, duration_hours, starting_capital)
             VALUES ($1, $2, $3, $4)
             RETURNING *`,
            [challengerId, opponentId, durationHours, capital],
        );
        const match = rows[0];

        // Insert allowed pairs
        if (allowedPairIds.length > 0) {
            const values = allowedPairIds.map((_, i) => `($1, $${i + 2})`).join(", ");
            await client.query(
                `INSERT INTO match_allowed_pairs (match_id, pair_id) VALUES ${values}`,
                [match.id, ...allowedPairIds],
            );
        }

        await client.query("COMMIT");
        return match;
    } catch (err) {
        await client.query("ROLLBACK");
        throw err;
    } finally {
        client.release();
    }
}

/**
 * Accept a pending match challenge. Sets status to ACTIVE with timestamps.
 */
export async function acceptMatch(matchId: string, acceptingUserId: string): Promise<MatchRow> {
    const client = await acquireClient();
    try {
        await client.query("BEGIN");

        const { rows } = await client.query<MatchRow>(
            `SELECT * FROM matches WHERE id = $1 FOR UPDATE`,
            [matchId],
        );
        if (rows.length === 0) throw new Error("match_not_found");

        const match = rows[0];
        if (match.status !== "PENDING") throw new Error("match_not_pending");
        if (match.opponent_id !== acceptingUserId) throw new Error("forbidden");

        const now = new Date();
        const endsAt = new Date(now.getTime() + match.duration_hours * 3600_000);

        const { rows: updated } = await client.query<MatchRow>(
            `UPDATE matches
             SET status = 'ACTIVE', started_at = $2, ends_at = $3
             WHERE id = $1
             RETURNING *`,
            [matchId, now.toISOString(), endsAt.toISOString()],
        );

        await client.query("COMMIT");

        const accepted = updated[0];

        // Notify both players via SSE so their browsers auto-transition
        const eventData = {
            matchId: accepted.id,
            challengerId: accepted.challenger_id,
            opponentId: accepted.opponent_id,
            duration: accepted.duration_hours,
            startedAt: accepted.started_at!,
        };
        publish(createEvent("match.started", eventData, { userId: accepted.challenger_id }));
        publish(createEvent("match.started", eventData, { userId: accepted.opponent_id }));

        return accepted;
    } catch (err) {
        await client.query("ROLLBACK");
        throw err;
    } finally {
        client.release();
    }
}

/**
 * Forfeit an active match. The non-forfeiting player wins.
 */
export async function forfeitMatch(matchId: string, forfeitUserId: string): Promise<MatchRow> {
    const client = await acquireClient();
    try {
        await client.query("BEGIN");

        const { rows } = await client.query<MatchRow>(
            `SELECT * FROM matches WHERE id = $1 FOR UPDATE`,
            [matchId],
        );
        if (rows.length === 0) throw new Error("match_not_found");

        const match = rows[0];
        if (match.status !== "ACTIVE") throw new Error("match_not_active");
        if (match.challenger_id !== forfeitUserId && match.opponent_id !== forfeitUserId) {
            throw new Error("forbidden");
        }

        const winnerId = match.challenger_id === forfeitUserId
            ? match.opponent_id
            : match.challenger_id;

        const { rows: updated } = await client.query<MatchRow>(
            `UPDATE matches
             SET status = 'FORFEITED',
                 forfeit_user_id = $2,
                 winner_id = $3,
                 completed_at = now()
             WHERE id = $1
             RETURNING *`,
            [matchId, forfeitUserId, winnerId],
        );

        // Apply full ELO resolution (streaks, tiers, badges) — idempotent
        const eloResult = await resolveMatchElo(matchId, client);
        if (eloResult) {
            logger.info({ matchId, ...eloResult }, "forfeit_elo_resolved");
        }

        await client.query("COMMIT");
        return updated[0];
    } catch (err) {
        await client.query("ROLLBACK");
        throw err;
    } finally {
        client.release();
    }
}

/**
 * Check if a user meets minimum trade requirements for a match.
 */
export async function checkMatchMinimumRequirements(
    matchId: string,
    userId: string,
): Promise<{ meetsRequirements: boolean; tradesCount: number; minTradesRequired: number }> {
    const { rows } = await pool.query<{ count: string }>(
        `SELECT count(*) FROM match_positions WHERE match_id = $1 AND user_id = $2 AND closed_at IS NOT NULL`,
        [matchId, userId],
    );
    const tradesCount = parseInt(rows[0].count, 10);
    return {
        meetsRequirements: tradesCount >= MIN_MATCH_TRADES,
        tradesCount,
        minTradesRequired: MIN_MATCH_TRADES,
    };
}

/**
 * Complete a match: calculate final scores, determine winner, apply ELO.
 */
export async function completeMatch(matchId: string): Promise<MatchRow> {
    const client = await acquireClient();
    try {
        await client.query("BEGIN");

        const { rows } = await client.query<MatchRow>(
            `SELECT * FROM matches WHERE id = $1 FOR UPDATE`,
            [matchId],
        );
        if (rows.length === 0) throw new Error("match_not_found");

        const match = rows[0];
        if (match.status !== "ACTIVE") throw new Error("match_not_active");

        const capital = parseFloat(match.starting_capital);

        // Force-close any open positions at current market price
        await forceCloseOpenPositions(matchId, client);

        // Calculate stats for each player
        const challengerStats = await calculatePlayerStats(matchId, match.challenger_id, capital, client);
        const opponentStats = await calculatePlayerStats(matchId, match.opponent_id, capital, client);

        // Determine winner by nuanced score
        let winnerId: string | null = null;
        if (challengerStats.score > opponentStats.score) {
            winnerId = match.challenger_id;
        } else if (opponentStats.score > challengerStats.score) {
            winnerId = match.opponent_id;
        }
        // If scores are exactly equal, it's a draw (winnerId stays null)

        // Set match to COMPLETED with stats + winner
        const { rows: updated } = await client.query<MatchRow>(
            `UPDATE matches SET
                status = 'COMPLETED',
                challenger_pnl_pct = $2,
                opponent_pnl_pct = $3,
                challenger_trades_count = $4,
                opponent_trades_count = $5,
                challenger_win_rate = $6,
                opponent_win_rate = $7,
                challenger_score = $8,
                opponent_score = $9,
                winner_id = $10,
                completed_at = now()
             WHERE id = $1
             RETURNING *`,
            [
                matchId,
                challengerStats.pnlPct, opponentStats.pnlPct,
                challengerStats.tradesCount, opponentStats.tradesCount,
                challengerStats.winRate, opponentStats.winRate,
                challengerStats.score, opponentStats.score,
                winnerId,
            ],
        );

        // Apply full ELO resolution (streaks, tiers, badges) — idempotent
        const eloResult = await resolveMatchElo(matchId, client);
        if (eloResult) {
            logger.info({ matchId, ...eloResult }, "match_elo_resolved");
        }

        await client.query("COMMIT");
        return updated[0];
    } catch (err) {
        await client.query("ROLLBACK");
        throw err;
    } finally {
        client.release();
    }
}

/**
 * Get a match by ID with player info.
 */
export async function getMatchById(matchId: string): Promise<MatchWithPlayers | null> {
    const { rows } = await pool.query<MatchWithPlayers>(
        `SELECT m.*,
                c.display_name AS challenger_name, c.elo_rating AS challenger_elo,
                o.display_name AS opponent_name, o.elo_rating AS opponent_elo
         FROM matches m
         JOIN users c ON c.id = m.challenger_id
         JOIN users o ON o.id = m.opponent_id
         WHERE m.id = $1`,
        [matchId],
    );
    return rows[0] ?? null;
}

/**
 * Get active match for a user (PENDING or ACTIVE).
 */
export async function getActiveMatchForUser(userId: string): Promise<MatchWithPlayers | null> {
    const { rows } = await pool.query<MatchWithPlayers>(
        `SELECT m.*,
                c.display_name AS challenger_name, c.elo_rating AS challenger_elo,
                o.display_name AS opponent_name, o.elo_rating AS opponent_elo
         FROM matches m
         JOIN users c ON c.id = m.challenger_id
         JOIN users o ON o.id = m.opponent_id
         WHERE (m.challenger_id = $1 OR m.opponent_id = $1)
           AND m.status IN ('PENDING', 'ACTIVE')
         LIMIT 1`,
        [userId],
    );
    return rows[0] ?? null;
}

/**
 * Get match history for a user.
 */
export async function getMatchHistory(
    userId: string,
    limit = 20,
    offset = 0,
): Promise<{ matches: MatchWithPlayers[]; total: number }> {
    const { rows: countRows } = await pool.query<{ count: string }>(
        `SELECT count(*) FROM matches
         WHERE (challenger_id = $1 OR opponent_id = $1)
           AND status IN ('COMPLETED', 'FORFEITED')`,
        [userId],
    );
    const total = parseInt(countRows[0].count, 10);

    const { rows } = await pool.query<MatchWithPlayers>(
        `SELECT m.*,
                c.display_name AS challenger_name, c.elo_rating AS challenger_elo,
                o.display_name AS opponent_name, o.elo_rating AS opponent_elo
         FROM matches m
         JOIN users c ON c.id = m.challenger_id
         JOIN users o ON o.id = m.opponent_id
         WHERE (m.challenger_id = $1 OR m.opponent_id = $1)
           AND m.status IN ('COMPLETED', 'FORFEITED')
         ORDER BY m.completed_at DESC
         LIMIT $2 OFFSET $3`,
        [userId, limit, offset],
    );
    return { matches: rows, total };
}

// ── Internal helpers ──

interface PlayerStats {
    pnlPct: number;
    tradesCount: number;
    winRate: number;
    consistency: number;
    score: number;
}

async function calculatePlayerStats(
    matchId: string,
    userId: string,
    startingCapital: number,
    client: PoolClient,
): Promise<PlayerStats> {
    // Get all closed positions for this player in this match
    const { rows: positions } = await client.query<{
        pnl: string | null;
    }>(
        `SELECT pnl FROM match_positions
         WHERE match_id = $1 AND user_id = $2 AND closed_at IS NOT NULL`,
        [matchId, userId],
    );

    const tradesCount = positions.length;
    if (tradesCount === 0) {
        return { pnlPct: 0, tradesCount: 0, winRate: 0, consistency: 0, score: 0 };
    }

    const pnls = positions.map((p) => parseFloat(p.pnl ?? "0"));
    const totalPnl = pnls.reduce((s, v) => s + v, 0);
    const pnlPct = (totalPnl / startingCapital) * 100;
    const wins = pnls.filter((p) => p > 0).length;
    const winRate = (wins / tradesCount) * 100;

    // Consistency = inverse of return standard deviation (higher = more consistent)
    const mean = totalPnl / tradesCount;
    const variance = pnls.reduce((s, v) => s + (v - mean) ** 2, 0) / tradesCount;
    const stddev = Math.sqrt(variance);
    // Normalize: consistency of 100 when stddev=0, approaches 0 as stddev grows
    const consistency = stddev === 0 ? 100 : Math.max(0, 100 - stddev / startingCapital * 10000);

    // Weighted composite score
    const score = calculateNuancedScore(pnlPct, winRate, tradesCount, consistency);

    return { pnlPct, tradesCount, winRate, consistency, score };
}

/**
 * Weighted scoring formula:
 *   P&L 50% + win rate 20% + trades 15% + consistency 15%
 *
 * Each component is normalized to a 0-100 scale before weighting.
 */
export function calculateNuancedScore(
    returnPct: number,
    winRate: number,
    tradesCount: number,
    consistencyScore: number,
): number {
    // P&L component: cap at +/-100% for scoring, scale to 0-100
    const pnlNorm = Math.min(100, Math.max(0, returnPct + 50)); // -50% → 0, 0% → 50, +50% → 100

    // Win rate is already 0-100
    const winRateNorm = Math.min(100, Math.max(0, winRate));

    // Trades: more trades = better, cap at 50 trades for full score
    const tradesNorm = Math.min(100, (tradesCount / 50) * 100);

    // Consistency is already 0-100
    const consistencyNorm = Math.min(100, Math.max(0, consistencyScore));

    return pnlNorm * 0.50 + winRateNorm * 0.20 + tradesNorm * 0.15 + consistencyNorm * 0.15;
}

/**
 * Force-close all open match positions at current market price.
 */
async function forceCloseOpenPositions(matchId: string, client: PoolClient): Promise<void> {
    const { rows: openPositions } = await client.query<{
        id: string;
        pair_id: string;
        side: string;
        entry_price: string;
        qty: string;
    }>(
        `SELECT mp.id, mp.pair_id, mp.side, mp.entry_price, mp.qty
         FROM match_positions mp
         WHERE mp.match_id = $1 AND mp.closed_at IS NULL`,
        [matchId],
    );

    for (const pos of openPositions) {
        // Get current price from snapshot store
        // Look up pair symbol for the snapshot
        const { rows: pairRows } = await client.query<{ symbol: string }>(
            `SELECT symbol FROM trading_pairs WHERE id = $1`,
            [pos.pair_id],
        );
        const symbol = pairRows[0]?.symbol;
        let exitPrice = parseFloat(pos.entry_price); // fallback: flat close

        if (symbol) {
            const snap = await getSnapshot(symbol, 60_000); // 60s stale tolerance
            if (snap) exitPrice = parseFloat(snap.last);
        }

        const entryPrice = parseFloat(pos.entry_price);
        const qty = parseFloat(pos.qty);
        const pnl = pos.side === "LONG"
            ? (exitPrice - entryPrice) * qty
            : (entryPrice - exitPrice) * qty;

        await client.query(
            `UPDATE match_positions
             SET exit_price = $2, pnl = $3, closed_at = now()
             WHERE id = $1`,
            [pos.id, exitPrice, pnl],
        );
    }
}
