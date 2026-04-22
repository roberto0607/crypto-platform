import type { PoolClient } from "pg";
import { pool, acquireClient } from "../db/pool.js";
import { resolveMatchElo, type TWTier } from "./eloService.js";
import { getUserTier } from "./tierRepo.js";
import { getSnapshot } from "../market/snapshotStore.js";
import { logger as rootLogger } from "../observability/logContext.js";
import { publish } from "../events/eventBus.js";
import { createEvent } from "../events/eventTypes.js";
import { createTrade } from "../trading/tradeRepo.js";
import { D, toFixed8 } from "../utils/decimal.js";

const logger = rootLogger.child({ module: "matchService" });

// ── Types ──

export interface MatchRow {
    id: string;
    season_id: string | null;
    challenger_id: string;
    opponent_id: string;
    status: "PENDING" | "ACTIVE" | "COMPLETED" | "FORFEITED" | "EXPIRED" | "CANCELLED";
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
    winner_elo_delta: number | null;
    loser_elo_delta: number | null;
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

        // Fetch challenger display name for the SSE payload
        const { rows: challengerRows } = await client.query<{ display_name: string | null }>(
            `SELECT display_name FROM users WHERE id = $1`,
            [challengerId],
        );

        await client.query("COMMIT");

        // Notify opponent via SSE so their browser shows the challenge
        publish(createEvent("challenge.received", {
            matchId: match.id,
            challengerId,
            challengerName: challengerRows[0]?.display_name ?? "Unknown",
            duration: durationHours,
            createdAt: match.created_at,
        }, { userId: opponentId }));

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

        if (!updated || updated.length === 0) {
            throw new Error("match_update_failed");
        }

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

        // Anti-gameability: force-close match-scoped positions and book the
        // realized PnL into the match stats. Without this the forfeiter
        // could escape a losing open position by forfeiting — now the loss
        // sticks and shows up in challenger_pnl_pct / opponent_pnl_pct.
        await closeMatchScopedPositions(matchId, client);

        const capital = parseFloat(match.starting_capital);
        const challengerStats = await calculatePlayerStats(matchId, match.challenger_id, capital, client);
        const opponentStats = await calculatePlayerStats(matchId, match.opponent_id, capital, client);

        const { rows: updated } = await client.query<MatchRow>(
            `UPDATE matches
             SET status = 'FORFEITED',
                 forfeit_user_id = $2,
                 winner_id = $3,
                 challenger_pnl_pct = $4,
                 opponent_pnl_pct = $5,
                 challenger_trades_count = $6,
                 opponent_trades_count = $7,
                 challenger_win_rate = $8,
                 opponent_win_rate = $9,
                 challenger_score = $10,
                 opponent_score = $11,
                 completed_at = now()
             WHERE id = $1
             RETURNING *`,
            [
                matchId, forfeitUserId, winnerId,
                challengerStats.pnlPct, opponentStats.pnlPct,
                challengerStats.tradesCount, opponentStats.tradesCount,
                challengerStats.winRate, opponentStats.winRate,
                challengerStats.score, opponentStats.score,
            ],
        );

        if (!updated || updated.length === 0) {
            throw new Error("match_update_failed");
        }

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

        // Force-close any open match-scoped positions at current market price.
        // Books realized PnL into positions.realized_pnl_quote so the next
        // calculatePlayerStats call picks it up.
        await closeMatchScopedPositions(matchId, client);

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

        if (!updated || updated.length === 0) {
            throw new Error("match_update_failed");
        }

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
                COALESCE(NULLIF(c.display_name, ''), split_part(c.email, '@', 1)) AS challenger_name,
                c.elo_rating AS challenger_elo,
                COALESCE(NULLIF(o.display_name, ''), split_part(o.email, '@', 1)) AS opponent_name,
                o.elo_rating AS opponent_elo
         FROM matches m
         JOIN users c ON c.id = m.challenger_id
         JOIN users o ON o.id = m.opponent_id
         WHERE m.id = $1`,
        [matchId],
    );
    return rows[0] ?? null;
}

/**
 * Returns the user's currently-running match id, or null if they're in
 * free-play. Uses the `one_active_match_per_*` partial unique indexes, so
 * this is at most a 1-row lookup.
 *
 * Only returns ACTIVE matches (not PENDING) — a match that hasn't started
 * shouldn't capture fills. Accepts an optional PoolClient so callers
 * inside a transaction can keep the lookup in the same txn.
 */
export async function getActiveMatchIdForUser(
    userId: string,
    client?: PoolClient,
): Promise<string | null> {
    const q = client ?? pool;
    const { rows } = await q.query<{ id: string }>(
        `SELECT id FROM matches
         WHERE (challenger_id = $1 OR opponent_id = $1)
           AND status = 'ACTIVE'
         LIMIT 1`,
        [userId],
    );
    return rows[0]?.id ?? null;
}

/**
 * Get active match for a user (PENDING or ACTIVE).
 */
export async function getActiveMatchForUser(userId: string): Promise<MatchWithPlayers | null> {
    const { rows } = await pool.query<MatchWithPlayers>(
        `SELECT m.*,
                COALESCE(NULLIF(c.display_name, ''), split_part(c.email, '@', 1)) AS challenger_name,
                c.elo_rating AS challenger_elo,
                COALESCE(NULLIF(o.display_name, ''), split_part(o.email, '@', 1)) AS opponent_name,
                o.elo_rating AS opponent_elo
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
 * Cancel a user's active/pending match.
 * Only allowed if the match is PENDING or ACTIVE with zero trades by either player.
 * If the match has trades, the user must forfeit instead.
 */
export async function cancelActiveMatch(userId: string): Promise<MatchRow> {
    const client = await acquireClient();
    try {
        await client.query("BEGIN");

        const { rows } = await client.query<MatchRow>(
            `SELECT * FROM matches
             WHERE (challenger_id = $1 OR opponent_id = $1)
               AND status IN ('PENDING', 'ACTIVE')
             FOR UPDATE
             LIMIT 1`,
            [userId],
        );
        if (rows.length === 0) throw new Error("match_not_found");

        const match = rows[0];

        // PENDING matches can always be cancelled
        if (match.status === "ACTIVE") {
            const totalTrades = (match.challenger_trades_count ?? 0) + (match.opponent_trades_count ?? 0);
            if (totalTrades > 0) {
                throw new Error("match_has_trades");
            }
        }

        const { rows: updated } = await client.query<MatchRow>(
            `UPDATE matches
             SET status = 'CANCELLED', completed_at = now()
             WHERE id = $1
             RETURNING *`,
            [match.id],
        );

        await client.query("COMMIT");

        logger.info({ matchId: match.id, userId, oldStatus: match.status }, "match_cancelled_by_user");
        return updated[0];
    } catch (err) {
        await client.query("ROLLBACK");
        throw err;
    } finally {
        client.release();
    }
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
                COALESCE(NULLIF(c.display_name, ''), split_part(c.email, '@', 1)) AS challenger_name,
                c.elo_rating AS challenger_elo,
                COALESCE(NULLIF(o.display_name, ''), split_part(o.email, '@', 1)) AS opponent_name,
                o.elo_rating AS opponent_elo,
                mer.winner_delta AS winner_elo_delta,
                mer.loser_delta AS loser_elo_delta
         FROM matches m
         JOIN users c ON c.id = m.challenger_id
         JOIN users o ON o.id = m.opponent_id
         LEFT JOIN match_elo_results mer ON mer.match_id = m.id
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
    // Stats come from the match-scoped positions table (the live aggregate),
    // not the deprecated match_positions table. Net realized P&L per row is
    // realized_pnl_quote - fees_paid_quote; trade count is the number of
    // FILLED orders for this user in this match. Win rate is the fraction
    // of position rows with positive net realized P&L.
    const { rows: positions } = await client.query<{
        realized_pnl_quote: string | null;
        fees_paid_quote: string | null;
    }>(
        `SELECT realized_pnl_quote, fees_paid_quote
         FROM positions
         WHERE match_id = $1 AND user_id = $2`,
        [matchId, userId],
    );

    const { rows: orderCountRows } = await client.query<{ count: string }>(
        `SELECT count(*) FROM orders
         WHERE match_id = $1 AND user_id = $2 AND status = 'FILLED'`,
        [matchId, userId],
    );
    const parsedTradesCount = parseInt(orderCountRows[0]?.count ?? "0", 10);
    const tradesCount = Number.isNaN(parsedTradesCount) ? 0 : parsedTradesCount;

    if (positions.length === 0) {
        return { pnlPct: 0, tradesCount, winRate: 0, consistency: 0, score: 0 };
    }

    const nets = positions.map((p) => {
        const realized = parseFloat(p.realized_pnl_quote ?? "0");
        const fees = parseFloat(p.fees_paid_quote ?? "0");
        const realizedSafe = Number.isNaN(realized) ? 0 : realized;
        const feesSafe = Number.isNaN(fees) ? 0 : fees;
        return realizedSafe - feesSafe;
    });

    const totalPnl = nets.reduce((s, v) => s + v, 0);
    const pnlPct = startingCapital > 0 ? (totalPnl / startingCapital) * 100 : 0;

    const wins = nets.filter((v) => v > 0).length;
    const winRate = positions.length > 0 ? (wins / positions.length) * 100 : 0;

    // Consistency = inverse of P&L standard deviation across the user's
    // match-scoped pair rows. With 1 pair traded this always yields 100.
    const mean = totalPnl / positions.length;
    const variance = nets.reduce((s, v) => s + (v - mean) ** 2, 0) / positions.length;
    const stddev = Math.sqrt(variance);
    const consistency = stddev === 0 || startingCapital <= 0
        ? 100
        : Math.max(0, 100 - (stddev / startingCapital) * 10000);

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
 * Synthetically close every match-scoped row in `positions` (the live
 * aggregate table) for this match. Books the unrealized PnL into
 * realized_pnl_quote, zeroes base_qty, and writes a synthetic trade row
 * marked is_system_fill=true so the audit trail shows the close.
 *
 * Called by completeMatch and forfeitMatch before their respective match
 * row UPDATE, so the realized PnL flows into calculatePlayerStats and
 * thence into match.challenger_pnl_pct / opponent_pnl_pct. This is the
 * anti-gameability guarantee — a user can't forfeit a losing open position
 * to escape the loss, because the close books the loss into the match score.
 */
async function closeMatchScopedPositions(
    matchId: string,
    client: PoolClient,
): Promise<{ closedCount: number; totalPnlRealized: string }> {
    // Lock match-scoped, non-flat position rows for the duration of the txn.
    const { rows: openPositions } = await client.query<{
        user_id: string;
        pair_id: string;
        base_qty: string;
        avg_entry_price: string;
        competition_id: string | null;
    }>(
        `SELECT user_id, pair_id, base_qty, avg_entry_price, competition_id
         FROM positions
         WHERE match_id = $1 AND base_qty <> 0
         FOR UPDATE`,
        [matchId],
    );

    let closedCount = 0;
    let totalPnl = D("0");

    for (const pos of openPositions) {
        // Exit-price fallback chain (mirrors forceCloseOpenPositions).
        const { rows: pairRows } = await client.query<{
            symbol: string;
            last_price: string | null;
            quote_asset_id: string;
        }>(
            `SELECT symbol, last_price, quote_asset_id
             FROM trading_pairs WHERE id = $1`,
            [pos.pair_id],
        );
        const pair = pairRows[0];
        const symbol = pair?.symbol;
        const lastPriceStr = pair?.last_price ?? null;
        const quoteAssetId = pair?.quote_asset_id ?? null;

        let exitPrice: number | null = null;
        let fallbackSource: "snapshot" | "trading_pairs.last_price" | "avg_entry_price" = "avg_entry_price";

        // 1. Live snapshot (<60s old)
        if (symbol) {
            const snap = await getSnapshot(symbol, 60_000);
            if (snap) {
                const snapPrice = parseFloat(snap.last);
                if (Number.isFinite(snapPrice) && snapPrice > 0) {
                    exitPrice = snapPrice;
                    fallbackSource = "snapshot";
                }
            }
        }

        // 2. trading_pairs.last_price
        if (exitPrice === null && lastPriceStr !== null) {
            const lp = parseFloat(lastPriceStr);
            if (Number.isFinite(lp) && lp > 0) {
                exitPrice = lp;
                fallbackSource = "trading_pairs.last_price";
            }
        }

        // 3. avg_entry_price (flat close — log a warning)
        if (exitPrice === null) {
            exitPrice = parseFloat(pos.avg_entry_price);
            logger.warn(
                { matchId, userId: pos.user_id, pairId: pos.pair_id },
                "close_match_position_used_entry_price_fallback",
            );
        }

        // Signed PnL formula works for both long (base_qty > 0) and short
        // (base_qty < 0): pnl = base_qty * (exit - entry).
        const baseQty = D(pos.base_qty);
        const avgEntry = D(pos.avg_entry_price);
        const exitD = D(exitPrice);
        const pnl = baseQty.mul(exitD.minus(avgEntry));

        await client.query(
            `UPDATE positions
             SET realized_pnl_quote = realized_pnl_quote + $3,
                 base_qty = 0,
                 avg_entry_price = 0,
                 updated_at = now()
             WHERE user_id = $1
               AND pair_id = $2
               AND match_id = $4`,
            [pos.user_id, pos.pair_id, toFixed8(pnl), matchId],
        );

        // Synthetic audit trade. The orders CHECK constraint requires at
        // least one of buy_order_id/sell_order_id to be non-null, so we
        // also synthesize a matching FILLED order to point to. Side is
        // opposite the position direction (SELL closes a long, BUY closes
        // a short).
        const closingSide = baseQty.isPositive() ? "SELL" : "BUY";
        const absQty = baseQty.abs();
        const quoteAmt = absQty.mul(exitD);

        const { rows: syntheticOrderRows } = await client.query<{ id: string }>(
            `INSERT INTO orders (
                user_id, pair_id, side, type, limit_price,
                qty, qty_filled, status,
                reserved_wallet_id, reserved_amount, reserved_consumed,
                competition_id, match_id
             ) VALUES ($1, $2, $3, 'MARKET', NULL,
                       $4, $4, 'FILLED',
                       NULL, '0', '0',
                       $5::uuid, $6::uuid)
             RETURNING id`,
            [pos.user_id, pos.pair_id, closingSide, toFixed8(absQty), pos.competition_id, matchId],
        );
        const syntheticOrderId = syntheticOrderRows[0]?.id ?? null;

        await createTrade(client, {
            pairId: pos.pair_id,
            buyOrderId: closingSide === "BUY" ? syntheticOrderId : null,
            sellOrderId: closingSide === "SELL" ? syntheticOrderId : null,
            price: toFixed8(exitD),
            qty: toFixed8(absQty),
            quoteAmount: toFixed8(quoteAmt),
            feeAmount: "0.00000000",
            feeAssetId: quoteAssetId,
            isSystemFill: true,
        });

        logger.info(
            {
                matchId,
                userId: pos.user_id,
                pairId: pos.pair_id,
                side: baseQty.isPositive() ? "LONG" : "SHORT",
                baseQty: pos.base_qty,
                exitPrice,
                realizedPnl: toFixed8(pnl),
                fallbackSource,
            },
            "match_scoped_position_closed",
        );

        closedCount++;
        totalPnl = totalPnl.plus(pnl);
    }

    return {
        closedCount,
        totalPnlRealized: toFixed8(totalPnl),
    };
}

/**
 * DEPRECATED: superseded by closeMatchScopedPositions. Retained only for
 * the case of any lingering match_positions rows from prior schema work.
 * Safe to remove in a followup.
 *
 * Force-close all open match positions at current market price.
 */
async function forceCloseOpenPositions(matchId: string, client: PoolClient): Promise<void> {
    // FOR UPDATE prevents two concurrent completeMatch calls from force-closing
    // the same position twice.
    const { rows: openPositions } = await client.query<{
        id: string;
        pair_id: string;
        side: string;
        entry_price: string;
        qty: string;
    }>(
        `SELECT mp.id, mp.pair_id, mp.side, mp.entry_price, mp.qty
         FROM match_positions mp
         WHERE mp.match_id = $1 AND mp.closed_at IS NULL
         FOR UPDATE`,
        [matchId],
    );

    for (const pos of openPositions) {
        // Get current price from snapshot store. Look up pair symbol + last_price
        // so we can fall back through snapshot → trading_pairs.last_price → entry_price.
        const { rows: pairRows } = await client.query<{
            symbol: string;
            last_price: string | null;
        }>(
            `SELECT symbol, last_price FROM trading_pairs WHERE id = $1`,
            [pos.pair_id],
        );
        const symbol = pairRows[0]?.symbol;
        const lastPriceStr = pairRows[0]?.last_price ?? null;

        // Preferred: live snapshot (<60s old).
        let exitPrice: number | null = null;
        if (symbol) {
            const snap = await getSnapshot(symbol, 60_000);
            if (snap) {
                const snapPrice = parseFloat(snap.last);
                if (Number.isFinite(snapPrice) && snapPrice > 0) exitPrice = snapPrice;
            }
        }

        // Fallback 1: trading_pairs.last_price (most recent persisted price).
        if (exitPrice === null && lastPriceStr !== null) {
            const lpNum = parseFloat(lastPriceStr);
            if (Number.isFinite(lpNum) && lpNum > 0) {
                exitPrice = lpNum;
                logger.warn(
                    { matchId, positionId: pos.id, pairId: pos.pair_id, source: "trading_pairs.last_price" },
                    "force_close_used_last_price_fallback",
                );
            }
        }

        // Fallback 2: entry_price (flat close). Log as error — this means both
        // live feed and persisted last_price are stale/missing.
        if (exitPrice === null) {
            exitPrice = parseFloat(pos.entry_price);
            logger.error(
                { matchId, positionId: pos.id, pairId: pos.pair_id, source: "entry_price" },
                "force_close_fell_back_to_entry_price_no_market_data",
            );
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
