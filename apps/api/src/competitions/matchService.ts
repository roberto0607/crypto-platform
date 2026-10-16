import type { PoolClient } from "pg";
import Decimal from "decimal.js";
import type { TriggerOrderRow } from "../triggers/triggerTypes.js";
import { triggerCanceledEvent, MATCH_ENDED_REASON } from "../triggers/positionCloseTriggers.js";
import { cancelMatchTriggersTx } from "../triggers/triggerRepo.js";
import { pool, acquireClient } from "../db/pool.js";
import {
    resolveMatchElo,
    ELO_TABLE,
    checkDemotion,
    getUserTierTx,
    updateUserTierTx,
    TW_TIERS,
    type TWTier,
} from "./eloService.js";
import type { MatchEloResult } from "./eloService.js";
import { getUserTier } from "./tierRepo.js";
import { logger as rootLogger } from "../observability/logContext.js";
import { publish } from "../events/eventBus.js";
import { createEvent } from "../events/eventTypes.js";
import { publishMatchEvent } from "../events/matchEvents.js";
import { createTrade } from "../trading/tradeRepo.js";
import { D, toFixed8 } from "../utils/decimal.js";
import { createMatchConversationTx } from "../chat/conversationRepo.js";
import {
    ClosePrices,
    cancelMatchOrdersTx,
    closeMatchWalletsTx,
    fundMatchWalletsTx,
    lockMatchWalletsTx,
    lockMatchPairsTx,
    settleMatchWalletsTx,
} from "./matchWallets.js";
import type { AppEvent } from "../events/eventTypes.js";
import { deleteMatchConversation } from "../chat/chatService.js";
import { config } from "../config.js";
import { pairRiskParams, settleIsolatedFillTx } from "../trading/isolatedSettlement.js";

const logger = rootLogger.child({ module: "matchService" });

// ── Types ──

export interface MatchRow {
    id: string;
    season_id: string | null;
    challenger_id: string;
    opponent_id: string;
    status: "PENDING" | "ACTIVE" | "COMPLETED" | "FORFEITED" | "CANCELLED";
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
    /** Stamped at accept (leverage PR 3): ISOLATED while LEVERAGE_ENABLED, else SPOT. */
    margin_mode: "SPOT" | "ISOLATED";
    max_leverage: string;
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

/**
 * Publish a terminal `match.ended` event to BOTH participants, and purge the
 * match's ephemeral chat conversation. Called after COMMIT in every terminal
 * transition (forfeit, timer-expiry complete, mutual forfeit) so the
 * opponent's browser renders the verdict instantly instead of waiting for its
 * next poll tick. Per-user delivery over the existing SSE eventBus — same
 * transport createMatch/acceptMatch already use.
 *
 * `loserUserId` is derived from the winner (the non-winner participant);
 * `null` for a draw / mutual forfeit (winner_id is null). `eloDeltas` is null
 * when no winner was resolved (draw / mutual forfeit).
 *
 * Chat purge runs here (not inside the terminal transition's own txn) because
 * it's best-effort like the SSE push, not required state: worst case a stale
 * conversation lingers an extra tick, whereas failing the whole forfeit/
 * complete over a chat-table error would be a much worse outcome.
 */
async function publishMatchEnded(
    match: MatchRow,
    reason: "forfeit" | "timeout" | "mutual_forfeit",
    eloResult: MatchEloResult | null,
): Promise<void> {
    // Best-effort notification. The transaction already COMMITted before this
    // runs, so a publish failure must NEVER propagate — the forfeit/complete
    // succeeded and the user's request must return 200 regardless of whether
    // the push fires (a missed push falls back to the client's poll/reconnect).
    try {
        const winnerUserId = match.winner_id;
        const loserUserId = winnerUserId
            ? (winnerUserId === match.challenger_id ? match.opponent_id : match.challenger_id)
            : null;
        const data = {
            matchId: match.id,
            winnerUserId,
            loserUserId,
            forfeitUserId: match.forfeit_user_id,
            reason,
            challengerPnlPct: match.challenger_pnl_pct,
            opponentPnlPct: match.opponent_pnl_pct,
            eloDeltas: eloResult
                ? { winner: eloResult.eloChanges.winner.delta, loser: eloResult.eloChanges.loser.delta }
                : null,
        };
        publishMatchEvent("match.ended", data, match);
    } catch (err) {
        logger.error({ err, matchId: match.id, reason }, "match_ended_publish_failed");
    }

    try {
        await deleteMatchConversation(match.id);
    } catch (err) {
        logger.error({ err, matchId: match.id, reason }, "match_chat_purge_failed");
    }
}

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

        // Leverage: the match's model and cap are stamped here, so changing
        // the flag or LEVERAGE_MAX_MATCH never affects a match in progress.
        // Flag off passes NULLs and leaves the column defaults (SPOT, 1x).
        const lev = config.leverage;
        const { rows: updated } = await client.query<MatchRow>(
            `UPDATE matches
             SET status = 'ACTIVE', started_at = $2, ends_at = $3,
                 margin_mode = COALESCE($4, margin_mode),
                 max_leverage = COALESCE($5::numeric, max_leverage)
             WHERE id = $1
             RETURNING *`,
            [
                matchId, now.toISOString(), endsAt.toISOString(),
                lev.enabled ? "ISOLATED" : null,
                lev.enabled ? lev.maxMatch.toFixed(2) : null,
            ],
        );

        if (!updated || updated.length === 0) {
            throw new Error("match_update_failed");
        }

        // Match wallets: each player's own account for this match, funded
        // with starting_capital (new money, not taken from free-play).
        await fundMatchWalletsTx(client, matchId, [match.challenger_id, match.opponent_id], match.starting_capital);

        // Match Chat: created atomically with the match going ACTIVE (not
        // best-effort like the SSE push below) — a failure here rolls back
        // the whole accept rather than leaving a match with no chat and no
        // retry path.
        await createMatchConversationTx(client, matchId, [match.challenger_id, match.opponent_id]);

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
            `SELECT * FROM matches WHERE id = $1 FOR NO KEY UPDATE`,
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
        const accountEvents = await settleMatchAccountsTx(matchId, client);
        const canceledTriggers = await cancelMatchTriggersTx(client, matchId, MATCH_ENDED_REASON);

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
        publishTriggersCanceled(canceledTriggers);
        publishAll(accountEvents);

        // Push the verdict to both players so the opponent's screen flips
        // instantly (forfeiter already has it from this request's response).
        await publishMatchEnded(updated[0], "forfeit", eloResult);
        return updated[0];
    } catch (err) {
        await client.query("ROLLBACK");
        throw err;
    } finally {
        client.release();
    }
}

/**
 * Complete a match: calculate final scores, determine winner, apply ELO.
 */
export async function completeMatch(matchId: string): Promise<MatchRow> {
    const client = await acquireClient();
    try {
        await client.query("BEGIN");

        const { rows } = await client.query<MatchRow>(
            `SELECT * FROM matches WHERE id = $1 FOR NO KEY UPDATE`,
            [matchId],
        );
        if (rows.length === 0) throw new Error("match_not_found");

        const match = rows[0];
        if (match.status !== "ACTIVE") throw new Error("match_not_active");

        const capital = parseFloat(match.starting_capital);

        // Force-close any open match-scoped positions at current market price.
        // Books realized PnL into positions.realized_pnl_quote so the next
        // calculatePlayerStats call picks it up.
        const accountEvents = await settleMatchAccountsTx(matchId, client);
        const canceledTriggers = await cancelMatchTriggersTx(client, matchId, MATCH_ENDED_REASON);

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
        publishTriggersCanceled(canceledTriggers);
        publishAll(accountEvents);

        // Timer-expiry completion — push the verdict to both players.
        await publishMatchEnded(updated[0], "timeout", eloResult);
        return updated[0];
    } catch (err) {
        await client.query("ROLLBACK");
        throw err;
    } finally {
        client.release();
    }
}

/**
 * Mutual forfeit — resolves an ACTIVE match that expired with zero FILLED
 * orders (both players accepted but neither traded). Both players take an
 * ELO loss penalty; the match transitions to FORFEITED with winner_id = NULL.
 *
 * Deliberately does NOT call resolveMatchElo: its NULL-winner branch is a
 * no-op that sets elo_resolved = true, which would poison the match against
 * any later ELO write. The per-player loss penalty is applied inline below,
 * mirroring the loser side of resolveMatchElo's normal path. No
 * match_elo_results row is written (its winner_id/loser_id are NOT NULL);
 * per-player deltas live in elo_history.
 */
export async function mutualForfeitMatch(matchId: string): Promise<MatchRow> {
    const client = await acquireClient();
    try {
        await client.query("BEGIN");

        const { rows } = await client.query<MatchRow>(
            `SELECT * FROM matches WHERE id = $1 FOR NO KEY UPDATE`,
            [matchId],
        );
        if (rows.length === 0) throw new Error("match_not_found");

        const match = rows[0];
        if (match.status !== "ACTIVE") throw new Error("match_not_active");

        // Exclusively for no-show matches. If any fills exist, the cleanup
        // job picked the wrong path (completeMatch handles traded matches) —
        // throw rather than silently mis-resolving a match that had trades.
        const { rows: fillRows } = await client.query<{ count: string }>(
            `SELECT count(*) FROM orders
             WHERE match_id = $1 AND status = 'FILLED'`,
            [matchId],
        );
        if (parseInt(fillRows[0].count, 10) > 0) throw new Error("match_has_trades");

        // Transition the match: FORFEITED, no winner, zero stats (no fills).
        // elo_resolved is set here directly — resolveMatchElo is never called.
        const { rows: updated } = await client.query<MatchRow>(
            `UPDATE matches SET
                status = 'FORFEITED',
                winner_id = NULL,
                forfeit_user_id = NULL,
                elo_delta = NULL,
                elo_resolved = true,
                challenger_pnl_pct = 0,
                opponent_pnl_pct = 0,
                challenger_trades_count = 0,
                opponent_trades_count = 0,
                challenger_win_rate = 0,
                opponent_win_rate = 0,
                challenger_score = 0,
                opponent_score = 0,
                completed_at = now()
             WHERE id = $1
             RETURNING *`,
            [matchId],
        );
        if (!updated || updated.length === 0) throw new Error("match_update_failed");

        // ── Per-player ELO loss penalty ──
        // Mirrors the loser side of resolveMatchElo: tier-based loss delta,
        // loss_count + 1, loss_streak + 1, win_streak reset, elo_history row,
        // demotion check. No streak multiplier, no badges, no promotion.
        const playerIds = [match.challenger_id, match.opponent_id];
        const { rows: players } = await client.query<{
            id: string;
            elo_rating: number;
        }>(
            `SELECT id, elo_rating FROM users WHERE id = ANY($1) FOR UPDATE`,
            [playerIds],
        );

        for (const playerId of playerIds) {
            const player = players.find((p) => p.id === playerId);
            if (!player) throw new Error("user_not_found");

            const tierRaw = await getUserTierTx(playerId, client);
            const tier: TWTier = (TW_TIERS as readonly string[]).includes(tierRaw)
                ? (tierRaw as TWTier)
                : "ROOKIE";

            const delta = ELO_TABLE[tier].lose; // negative number
            const newElo = Math.max(0, player.elo_rating + delta);

            await client.query(
                `UPDATE users SET
                    elo_rating = $1,
                    loss_count = loss_count + 1,
                    loss_streak = loss_streak + 1,
                    win_streak = 0
                 WHERE id = $2`,
                [newElo, playerId],
            );

            await client.query(
                `INSERT INTO elo_history (user_id, old_elo, new_elo, change_reason, match_id)
                 VALUES ($1, $2, $3, 'MATCH_LOSS', $4)`,
                [playerId, player.elo_rating, newElo, matchId],
            );

            const demotedTo = checkDemotion(tier, newElo);
            if (demotedTo) {
                await updateUserTierTx(client, playerId, demotedTo, tier, "MATCH_DEMOTION");
            }

            logger.info(
                { matchId, userId: playerId, tier, delta, oldElo: player.elo_rating, newElo },
                "mutual_forfeit_elo_applied",
            );
        }

        const accountEvents = await settleMatchAccountsTx(matchId, client);
        const canceledTriggers = await cancelMatchTriggersTx(client, matchId, MATCH_ENDED_REASON);

        await client.query("COMMIT");
        publishTriggersCanceled(canceledTriggers);
        publishAll(accountEvents);
        logger.info({ matchId }, "match_mutual_forfeited");

        // No winner — both players see DRAW. Push so both screens flip instantly.
        await publishMatchEnded(updated[0], "mutual_forfeit", null);
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

export type MatchViewRole = "participant" | "spectator" | "none";

/**
 * Resolve what a requester is allowed to see for a match — a shared
 * decision point for GET /matches/:id and match chat reads, replacing the
 * previously-duplicated inline challenger_id/opponent_id checks. Spectating
 * is fully public (per the locked product decision) but scoped to ACTIVE
 * matches only — once a match ends, only its two participants can still
 * view it (post-match detail is a separate, participant-only feature).
 */
export function canViewMatch(
    match: Pick<MatchRow, "challenger_id" | "opponent_id" | "status">,
    userId: string,
): MatchViewRole {
    if (match.challenger_id === userId || match.opponent_id === userId) return "participant";
    if (match.status === "ACTIVE") return "spectator";
    return "none";
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
             FOR NO KEY UPDATE
             LIMIT 1`,
            [userId],
        );
        if (rows.length === 0) throw new Error("match_not_found");

        const match = rows[0];

        // PENDING matches can always be cancelled. For ACTIVE matches, gate on
        // a LIVE fill count — the persisted challenger_trades_count /
        // opponent_trades_count columns are only written by completeMatch /
        // forfeitMatch at terminal states, so mid-match they are structurally
        // always 0 and would let a losing player cancel to dodge the ELO loss
        // forfeit imposes. This query mirrors calculatePlayerStats' count.
        if (match.status === "ACTIVE") {
            const { rows: fillRows } = await client.query<{ count: string }>(
                `SELECT count(*) FROM orders
                 WHERE match_id = $1 AND status = 'FILLED'`,
                [match.id],
            );
            const liveFillCount = parseInt(fillRows[0].count, 10);
            if (liveFillCount > 0) {
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
        // A PENDING match has no wallets or orders — this is then a no-op.
        const accountEvents = await settleMatchAccountsTx(match.id, client);
        const canceledTriggers = await cancelMatchTriggersTx(client, match.id, MATCH_ENDED_REASON);

        await client.query("COMMIT");
        publishTriggersCanceled(canceledTriggers);
        publishAll(accountEvents);

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

/**
 * All currently-ACTIVE matches platform-wide, for the spectate-browse list —
 * unlike every other match query in this file, deliberately NOT scoped to a
 * requester. Modeled on GET /v1/competitions (v1Competitions.ts), the
 * existing precedent for a public, unscoped, status-filtered list endpoint.
 * idx_matches_status already covers `status = 'ACTIVE'` — no new index
 * needed.
 */
export async function listActiveMatches(limit = 50): Promise<MatchWithPlayers[]> {
    const { rows } = await pool.query<MatchWithPlayers>(
        `SELECT m.*,
                COALESCE(NULLIF(c.display_name, ''), split_part(c.email, '@', 1)) AS challenger_name,
                c.elo_rating AS challenger_elo,
                COALESCE(NULLIF(o.display_name, ''), split_part(o.email, '@', 1)) AS opponent_name,
                o.elo_rating AS opponent_elo
         FROM matches m
         JOIN users c ON c.id = m.challenger_id
         JOIN users o ON o.id = m.opponent_id
         WHERE m.status = 'ACTIVE'
         ORDER BY m.started_at DESC
         LIMIT $1`,
        [limit],
    );
    return rows;
}

// ── Internal helpers ──

export interface PlayerStats {
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

    const stats = playerStatsFromRows(positions, startingCapital, tradesCount);
    // calculateNuancedScore clamps P&L to ±50%. Leverage makes that bite more
    // often (blowing up and nearly blowing up score the same); v1 keeps the
    // formula and logs it to decide with data (leverage design §5).
    if (Math.abs(stats.pnlPct) > 50) {
        logger.info({ matchId, userId, pnlPct: stats.pnlPct, score: stats.score }, "score_pnl_clamped");
    }
    return stats;
}

/**
 * The pure part of calculatePlayerStats: a player's match stats from their
 * match-scoped position rows. Exported so read-only reports can recompute a
 * score with the exact same formula.
 */
export function playerStatsFromRows(
    positions: { realized_pnl_quote: string | null; fees_paid_quote: string | null }[],
    startingCapital: number,
    tradesCount: number,
): PlayerStats {
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
 * Signed mark-to-market PnL for a single position row, given a current
 * price. Works for both long (base_qty > 0) and short (base_qty < 0):
 * pnl = base_qty * (currentPrice - avg_entry_price). Extracted from
 * closeMatchScopedPositions's force-close formula so the live in-match
 * PnL push (matchPnlEngine.ts) can reuse the exact same math read-only,
 * instead of re-deriving it.
 */
export function computeUnrealizedRowPnl(
    baseQty: string,
    avgEntryPrice: string,
    currentPrice: string | number,
): string {
    const qty = D(baseQty);
    const entry = D(avgEntryPrice);
    const price = D(typeof currentPrice === "number" ? currentPrice.toString() : currentPrice);
    return toFixed8(qty.mul(price.minus(entry)));
}

export interface LivePositionRow {
    pairId: string;
    baseQty: string;
    avgEntryPrice: string;
    realizedPnlQuote: string;
    feesPaidQuote: string;
    /** ISOLATED rows cap the unrealized loss at the margin. Absent = SPOT. */
    marginMode?: "SPOT" | "ISOLATED" | string;
    isolatedMargin?: string;
}

/**
 * Aggregate one user's live match PnL% across every position row they hold
 * in the match: already-booked realized P&L (net of fees) on every row,
 * plus unrealized mark-to-market on any row still open (base_qty != 0).
 * Shared by the force-close write path (closeMatchScopedPositions, which
 * additionally books the result and zeroes the row) and the live in-match
 * push (matchPnlEngine.ts, read-only) -- same aggregation
 * calculatePlayerStats already does for realized-only, extended with the
 * unrealized term calculatePlayerStats never needed (it only ever runs
 * after closeMatchScopedPositions has already zeroed every row).
 *
 * An ISOLATED (leveraged) row's unrealized loss is capped at its margin,
 * the most the position can lose, so a player's live P&L floors at −100%.
 *
 * currentPriceByPair only needs entries for pairs with an open row -- a
 * missing/non-finite price for one pair falls back to realized-only for
 * that row (best-effort) rather than throwing, so one pair's momentarily
 *-stale snapshot doesn't blank the whole match's PnL.
 */
export function computeLiveMatchPnl(
    positions: LivePositionRow[],
    currentPriceByPair: Map<string, number>,
    startingCapital: number,
): number {
    if (startingCapital <= 0) return 0;

    let total = D("0");
    for (const pos of positions) {
        total = total.plus(D(pos.realizedPnlQuote || "0")).minus(D(pos.feesPaidQuote || "0"));

        const baseQty = D(pos.baseQty || "0");
        if (!baseQty.isZero()) {
            const price = currentPriceByPair.get(pos.pairId);
            if (price !== undefined && Number.isFinite(price)) {
                let unrealized = D(computeUnrealizedRowPnl(pos.baseQty, pos.avgEntryPrice, price));
                if (pos.marginMode === "ISOLATED") {
                    unrealized = Decimal.max(unrealized, D(pos.isolatedMargin || "0").neg());
                }
                total = total.plus(unrealized);
            }
        }
    }

    return total.div(startingCapital).mul(100).toNumber();
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
 * End a match's accounts, inside the caller's match-end transaction (all 4
 * paths: complete, forfeit, mutual forfeit, cancel). Each path locks the
 * match row FOR NO KEY UPDATE, not FOR UPDATE: it still serializes the match-
 * end paths with each other and with accept, but it doesn't block the
 * key-share lock an in-flight match order's INSERTs take through their
 * match_id foreign keys. With FOR UPDATE that order (holding its pair and
 * wallets) and match end (holding the match row, waiting on them) deadlock.
 *   0. lock the trading pairs it may touch (matchWallets.lockMatchPairsTx):
 *      the force-close's synthetic order/trade rows need a key-share lock on
 *      their pair, so pairs come first, as in trading (pair → wallets →
 *      positions); otherwise an in-flight order on the pair deadlocks with it
 *   1. cancel the match's open orders (holds released)
 *   2. lock the match wallets — before positions, the same order trading
 *      takes them in (pair → wallets → positions), so an in-flight match fill
 *      waits and then hits closed wallets (match_ended) instead of deadlocking
 *   3. force-close positions (score) and settle the wallets to USD at the
 *      same fair price (closing a long at the bid, a short at the ask). An
 *      ISOLATED position settles its margin + P&L (loss-capped) into USD in
 *      the force-close; it has no base wallet balance to settle
 *   4. close the wallets — final balances kept, nothing moves to free-play
 * Returns the events to publish after COMMIT.
 */
async function settleMatchAccountsTx(matchId: string, client: PoolClient): Promise<AppEvent[]> {
    await lockMatchPairsTx(client, matchId);
    const events = await cancelMatchOrdersTx(client, matchId);
    await lockMatchWalletsTx(client, matchId);
    const prices = new ClosePrices();
    await closeMatchScopedPositions(matchId, client, prices);
    await settleMatchWalletsTx(client, matchId, prices);
    // wallet.updated for every wallet's final state (released holds included).
    const closed = await closeMatchWalletsTx(client, matchId);
    return [...events, ...closed];
}

/** After COMMIT: publish events (never let a publish break match end). */
function publishAll(events: AppEvent[]): void {
    for (const e of events) {
        try {
            publish(e);
        } catch {
            // Events must never break match completion
        }
    }
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
    prices: ClosePrices,
): Promise<{ closedCount: number; totalPnlRealized: string }> {
    // Lock match-scoped, non-flat position rows for the duration of the txn.
    const { rows: openPositions } = await client.query<{
        user_id: string;
        pair_id: string;
        base_qty: string;
        avg_entry_price: string;
        competition_id: string | null;
        margin_mode: "SPOT" | "ISOLATED";
        leverage: string;
    }>(
        `SELECT user_id, pair_id, base_qty, avg_entry_price, competition_id, margin_mode, leverage::text
         FROM positions
         WHERE match_id = $1 AND base_qty <> 0
         FOR UPDATE`,
        [matchId],
    );

    let closedCount = 0;
    let totalPnl = D("0");
    for (const pos of openPositions) {
        // Fair close price (matchWallets.ClosePrices): closing a long sells at
        // the bid, a short buys at the ask — the same price the wallet
        // settlement uses, so the score and the match wallets agree.
        const { rows: pairRows } = await client.query<{ quote_asset_id: string }>(
            `SELECT quote_asset_id FROM trading_pairs WHERE id = $1`,
            [pos.pair_id],
        );
        const quoteAssetId = pairRows[0]?.quote_asset_id ?? null;
        const close = await prices.get(client, pos.pair_id, D(pos.base_qty).isPositive(), pos.avg_entry_price);
        const exitPrice = close.price.toNumber();
        const fallbackSource = close.source;
        if (fallbackSource === "avg_entry_price") {
            logger.warn(
                { matchId, userId: pos.user_id, pairId: pos.pair_id },
                "close_match_position_used_entry_price_fallback",
            );
        }

        // Signed PnL formula works for both long (base_qty > 0) and short
        // (base_qty < 0): pnl = base_qty * (exit - entry). Shared with the
        // live in-match PnL push via computeUnrealizedRowPnl.
        const baseQty = D(pos.base_qty);
        const exitD = close.price;
        const isolated = pos.margin_mode === "ISOLATED";
        let pnl = D(computeUnrealizedRowPnl(pos.base_qty, pos.avg_entry_price, exitD.toString()));

        // SPOT: book the P&L on the row here; settleMatchWalletsTx then sells
        // the base wallet at the same price. ISOLATED holds no base: the
        // close is settled below like any other close of the position.
        if (!isolated) {
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
        }

        // Synthetic audit trade. The orders CHECK constraint requires at
        // least one of buy_order_id/sell_order_id to be non-null, so we
        // also synthesize a matching FILLED order to point to. Side is
        // opposite the position direction (SELL closes a long, BUY closes
        // a short). It carries the position's model and leverage.
        const closingSide = baseQty.isPositive() ? "SELL" : "BUY";
        const absQty = baseQty.abs();
        const quoteAmt = absQty.mul(exitD);

        const { rows: syntheticOrderRows } = await client.query<{ id: string }>(
            `INSERT INTO orders (
                user_id, pair_id, side, type, limit_price,
                qty, qty_filled, status,
                reserved_wallet_id, reserved_amount, reserved_consumed,
                competition_id, match_id, margin_mode, leverage
             ) VALUES ($1, $2, $3, 'MARKET', NULL,
                       $4, $4, 'FILLED',
                       NULL, '0', '0',
                       $5::uuid, $6::uuid, $7, $8)
             RETURNING id`,
            [pos.user_id, pos.pair_id, closingSide, toFixed8(absQty), pos.competition_id, matchId,
                pos.margin_mode, pos.leverage],
        );
        const syntheticOrderId = syntheticOrderRows[0]?.id ?? null;

        const trade = await createTrade(client, {
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

        // ISOLATED: the same settlement as a close through the engine —
        // margin released, P&L booked with the loss cap (a gap past
        // bankruptcy loses the margin, never more; the excess is recorded as
        // LIQUIDATION_SHORTFALL), position flat. Fee-free, like the SPOT
        // force-close. The match USD wallet is already locked.
        let shortfall: Decimal | null = null;
        if (isolated) {
            const { rows: usdRows } = await client.query<{ id: string }>(
                `SELECT id FROM wallets
                 WHERE user_id = $1 AND match_id = $2 AND asset_id = $3 AND competition_id IS NULL`,
                [pos.user_id, matchId, quoteAssetId],
            );
            if (!usdRows[0]) throw new Error("match_wallets_missing");
            const { mmrBps } = await pairRiskParams(client, pos.pair_id);
            const settled = await settleIsolatedFillTx(client, {
                userId: pos.user_id,
                pairId: pos.pair_id,
                scope: { competitionId: pos.competition_id, matchId },
                side: closingSide,
                qty: toFixed8(absQty),
                price: toFixed8(exitD),
                fee: "0.00000000",
                feeRole: "TAKER",
                leverage: D(pos.leverage),
                mmrBps,
                usdWalletId: usdRows[0].id,
                tradeId: trade.id,
                ts: new Date(trade.executed_at).getTime(),
            });
            pnl = settled.bookedPnl;
            if (settled.shortfall.gt(0)) shortfall = settled.shortfall;
        }

        logger.info(
            {
                matchId,
                userId: pos.user_id,
                pairId: pos.pair_id,
                side: baseQty.isPositive() ? "LONG" : "SHORT",
                baseQty: pos.base_qty,
                marginMode: pos.margin_mode,
                exitPrice,
                realizedPnl: toFixed8(pnl),
                ...(shortfall ? { shortfall: toFixed8(shortfall) } : {}),
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

/** After COMMIT: tell each player's UI that the match's triggers are gone. */
function publishTriggersCanceled(rows: TriggerOrderRow[]): void {
    for (const row of rows) {
        try {
            publish(triggerCanceledEvent(row, MATCH_ENDED_REASON));
        } catch {
            // Events must never break match completion
        }
    }
}

