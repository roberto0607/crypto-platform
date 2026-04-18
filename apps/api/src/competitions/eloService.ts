import type { PoolClient } from "pg";
import { logger as rootLogger } from "../observability/logContext";
// tierRepo used by legacy applyEloChange callers; tx-safe helpers below for resolveMatchElo

const logger = rootLogger.child({ module: "eloService" });

// ── Trade Wars Tier System (4 tiers) ──

export const TW_TIERS = ["ROOKIE", "PRO", "ELITE", "LEGEND"] as const;
export type TWTier = (typeof TW_TIERS)[number];

function isTWTier(s: string): s is TWTier {
    return (TW_TIERS as readonly string[]).includes(s);
}

/**
 * Asymmetric ELO deltas per tier.
 * Lower tiers are forgiving (easy to gain, hard to lose).
 * Higher tiers are punishing (hard to gain, easy to lose).
 */
const ELO_TABLE: Record<TWTier, { win: number; lose: number }> = {
    ROOKIE: { win: 15, lose: -3 },
    PRO:    { win: 12, lose: -8 },
    ELITE:  { win: 10, lose: -15 },
    LEGEND: { win: 8,  lose: -25 },
};

/** Win streak multipliers — checked AFTER incrementing streak */
function getStreakMultiplier(newStreak: number): number {
    if (newStreak >= 10) return 2.0;
    if (newStreak >= 5) return 1.5;
    if (newStreak >= 3) return 1.2;
    return 1.0;
}

/** Streak badge milestones */
function getStreakBadge(newStreak: number): string | null {
    if (newStreak === 10) return "STREAK_10";
    if (newStreak === 5) return "STREAK_5";
    if (newStreak === 3) return "STREAK_3";
    return null;
}

// ── Tier promotion/demotion ──

interface TierThreshold {
    tier: TWTier;
    eloMin: number;
    winsMin: number;
}

const PROMOTION_THRESHOLDS: TierThreshold[] = [
    { tier: "PRO",    eloMin: 1200, winsMin: 5 },
    { tier: "ELITE",  eloMin: 1500, winsMin: 15 },
    { tier: "LEGEND", eloMin: 1800, winsMin: 30 },
];

function checkPromotion(currentTier: TWTier, newElo: number, totalWins: number): TWTier | null {
    // Check from highest to lowest
    for (let i = PROMOTION_THRESHOLDS.length - 1; i >= 0; i--) {
        const t = PROMOTION_THRESHOLDS[i]!;
        if (newElo >= t.eloMin && totalWins >= t.winsMin) {
            const tierIndex = TW_TIERS.indexOf(t.tier);
            if (tierIndex > TW_TIERS.indexOf(currentTier)) {
                return t.tier;
            }
        }
    }
    return null;
}

function checkDemotion(currentTier: TWTier, newElo: number): TWTier | null {
    if (currentTier === "ROOKIE") return null;
    if (currentTier === "LEGEND" && newElo < 1800) return "ROOKIE";
    if (currentTier === "ELITE" && newElo < 1500) return "PRO";
    if (currentTier === "PRO" && newElo < 1200) return "ROOKIE";
    return null;
}

// ── Public interfaces ──

export interface EloChange {
    winnerDelta: number;
    loserDelta: number;
}

export interface MatchEloResult {
    winnerId: string;
    loserId: string;
    eloChanges: {
        winner: { oldElo: number; newElo: number; delta: number };
        loser: { oldElo: number; newElo: number; delta: number };
    };
    tierChanges: {
        winner: { before: string; after: string } | null;
        loser: { before: string; after: string } | null;
    };
    badgesEarned: string[];
    winnerWinStreak: number;
    streakMultiplier: number;
}

/**
 * Calculate ELO change for a match result.
 * Uses flat tier-based deltas (not classic K-factor formula).
 */
export function calculateEloChange(winnerElo: number, loserElo: number, tier: TWTier): EloChange {
    const table = ELO_TABLE[tier];
    const upsetBonus = winnerElo < loserElo ? 3 : 0;
    return {
        winnerDelta: table.win + upsetBonus,
        loserDelta: table.lose,
    };
}

/**
 * Legacy wrapper — apply ELO changes without streak/tier logic.
 * Used by forfeitMatch where simplified ELO is fine.
 */
export async function applyEloChange(
    winnerId: string,
    loserId: string,
    matchId: string,
    tier: TWTier,
    client: PoolClient,
): Promise<EloChange> {
    const { rows: eloRows } = await client.query<{ id: string; elo_rating: number }>(
        `SELECT id, elo_rating FROM users WHERE id = ANY($1) FOR UPDATE`,
        [[winnerId, loserId]],
    );

    // users.id is a PK so duplicates should be impossible. Filter by exact id
    // and log if the defensive check ever trips — indicates a schema violation.
    const winnerMatches = eloRows.filter((r) => r.id === winnerId);
    const loserMatches = eloRows.filter((r) => r.id === loserId);
    if (winnerMatches.length > 1 || loserMatches.length > 1) {
        logger.error(
            { winnerId, loserId, winnerCount: winnerMatches.length, loserCount: loserMatches.length },
            "elo_duplicate_user_rows_detected",
        );
    }
    const winnerRow = winnerMatches[0];
    const loserRow = loserMatches[0];
    if (!winnerRow || !loserRow) throw new Error("user_not_found");

    const change = calculateEloChange(winnerRow.elo_rating, loserRow.elo_rating, tier);

    const newWinnerElo = Math.max(0, winnerRow.elo_rating + change.winnerDelta);
    const newLoserElo = Math.max(0, loserRow.elo_rating + change.loserDelta);

    await client.query(`UPDATE users SET elo_rating = $1 WHERE id = $2`, [newWinnerElo, winnerId]);
    await client.query(`UPDATE users SET elo_rating = $1 WHERE id = $2`, [newLoserElo, loserId]);

    await client.query(
        `INSERT INTO elo_history (user_id, old_elo, new_elo, change_reason, match_id) VALUES ($1, $2, $3, $4, $5)`,
        [winnerId, winnerRow.elo_rating, newWinnerElo, "MATCH_WIN", matchId],
    );
    await client.query(
        `INSERT INTO elo_history (user_id, old_elo, new_elo, change_reason, match_id) VALUES ($1, $2, $3, $4, $5)`,
        [loserId, loserRow.elo_rating, newLoserElo, "MATCH_LOSS", matchId],
    );

    return change;
}

/**
 * Full ELO resolution for a completed match.
 *
 * - Loads match + both players (locked FOR UPDATE)
 * - Calculates tier-based ELO delta with streak multiplier
 * - Updates win/loss counts and streaks
 * - Checks promotion/demotion for both players
 * - Awards streak badges
 * - Records full result in match_elo_results
 * - Idempotent: skips if match.elo_resolved is already true
 *
 * Must be called within a transaction (pass PoolClient).
 */
export async function resolveMatchElo(
    matchId: string,
    client: PoolClient,
): Promise<MatchEloResult | null> {
    // ── Load match (FOR UPDATE for idempotency check) ──
    const { rows: matchRows } = await client.query<{
        id: string;
        status: string;
        winner_id: string | null;
        challenger_id: string;
        opponent_id: string;
        elo_resolved: boolean;
    }>(
        `SELECT id, status, winner_id, challenger_id, opponent_id, elo_resolved
         FROM matches WHERE id = $1 FOR UPDATE`,
        [matchId],
    );

    if (matchRows.length === 0) throw new Error("match_not_found");
    const match = matchRows[0];

    // Idempotency: already resolved
    if (match.elo_resolved) return null;

    // Must have a winner
    if (!match.winner_id) {
        // Draw — mark resolved but no ELO changes
        await client.query(`UPDATE matches SET elo_resolved = true WHERE id = $1`, [matchId]);
        return null;
    }

    const winnerId = match.winner_id;
    const loserId = winnerId === match.challenger_id ? match.opponent_id : match.challenger_id;

    // ── Load both players (FOR UPDATE to lock rows) ──
    const { rows: userRows } = await client.query<{
        id: string;
        elo_rating: number;
        win_count: number;
        loss_count: number;
        win_streak: number;
        loss_streak: number;
    }>(
        `SELECT id, elo_rating, win_count, loss_count, win_streak, loss_streak
         FROM users WHERE id = ANY($1) FOR UPDATE`,
        [[winnerId, loserId]],
    );

    const winner = userRows.find((r) => r.id === winnerId);
    const loser = userRows.find((r) => r.id === loserId);
    if (!winner || !loser) throw new Error("user_not_found");

    // ── Get tiers at match time (BEFORE any changes) ──
    const winnerTierRaw = await getUserTierTx(winnerId, client);
    const loserTierRaw = await getUserTierTx(loserId, client);
    const winnerTier: TWTier = isTWTier(winnerTierRaw) ? winnerTierRaw : "ROOKIE";
    const loserTier: TWTier = isTWTier(loserTierRaw) ? loserTierRaw : "ROOKIE";

    // ── Calculate base ELO deltas ──
    const winnerBase = calculateEloChange(winner.elo_rating, loser.elo_rating, winnerTier);
    const loserChange = calculateEloChange(loser.elo_rating, winner.elo_rating, loserTier);

    // ── Win streak: increment BEFORE checking multiplier ──
    const newWinStreak = winner.win_streak + 1;
    const streakMultiplier = getStreakMultiplier(newWinStreak);
    const winnerDelta = Math.round(winnerBase.winnerDelta * streakMultiplier);
    const loserDelta = loserChange.loserDelta; // negative number

    // ── Apply ELO ──
    const winnerNewElo = Math.max(0, winner.elo_rating + winnerDelta);
    const loserNewElo = Math.max(0, loser.elo_rating + loserDelta);

    // ── Update winner: ELO, win_count+1, win_streak+1, loss_streak=0 ──
    await client.query(
        `UPDATE users SET
            elo_rating = $1,
            win_count = win_count + 1,
            win_streak = $2,
            loss_streak = 0
         WHERE id = $3`,
        [winnerNewElo, newWinStreak, winnerId],
    );

    // ── Update loser: ELO, loss_count+1, loss_streak+1, win_streak=0 ──
    const newLossStreak = loser.loss_streak + 1;
    await client.query(
        `UPDATE users SET
            elo_rating = $1,
            loss_count = loss_count + 1,
            loss_streak = $2,
            win_streak = 0
         WHERE id = $3`,
        [loserNewElo, newLossStreak, loserId],
    );

    // ── ELO history ──
    await client.query(
        `INSERT INTO elo_history (user_id, old_elo, new_elo, change_reason, match_id) VALUES ($1, $2, $3, $4, $5)`,
        [winnerId, winner.elo_rating, winnerNewElo, "MATCH_WIN", matchId],
    );
    await client.query(
        `INSERT INTO elo_history (user_id, old_elo, new_elo, change_reason, match_id) VALUES ($1, $2, $3, $4, $5)`,
        [loserId, loser.elo_rating, loserNewElo, "MATCH_LOSS", matchId],
    );

    // ── Check promotion/demotion ──
    const winnerNewWins = winner.win_count + 1;

    let winnerTierAfter = winnerTier;
    const winnerPromo = checkPromotion(winnerTier, winnerNewElo, winnerNewWins);
    if (winnerPromo) {
        winnerTierAfter = winnerPromo;
        await updateUserTierTx(client, winnerId, winnerPromo, winnerTier, "MATCH_PROMOTION");
    }

    let loserTierAfter = loserTier;
    const loserDemo = checkDemotion(loserTier, loserNewElo);
    if (loserDemo) {
        loserTierAfter = loserDemo;
        await updateUserTierTx(client, loserId, loserDemo, loserTier, "MATCH_DEMOTION");
    }

    // Also check if winner got demoted (shouldn't happen on a win, but be safe)
    // And if loser got promoted (also shouldn't happen on a loss)

    // ── Streak badges ──
    const badges: string[] = [];
    const streakBadge = getStreakBadge(newWinStreak);
    if (streakBadge) {
        badges.push(streakBadge);
        await client.query(
            `INSERT INTO user_badges (user_id, badge_type, tier, metadata, earned_at)
             VALUES ($1, $2, $3, $4, now())
             ON CONFLICT DO NOTHING`,
            [winnerId, streakBadge, winnerTierAfter, JSON.stringify({ matchId, streak: newWinStreak })],
        );
    }

    // ── Mark match as ELO-resolved ──
    await client.query(
        `UPDATE matches SET elo_resolved = true, elo_delta = $2 WHERE id = $1`,
        [matchId, winnerDelta],
    );

    // ── Record detailed result ──
    await client.query(
        `INSERT INTO match_elo_results (
            match_id, winner_id, loser_id,
            winner_old_elo, winner_new_elo, winner_delta,
            loser_old_elo, loser_new_elo, loser_delta,
            winner_tier_before, winner_tier_after,
            loser_tier_before, loser_tier_after,
            winner_win_streak, loser_loss_streak,
            streak_multiplier, badges_earned
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [
            matchId, winnerId, loserId,
            winner.elo_rating, winnerNewElo, winnerDelta,
            loser.elo_rating, loserNewElo, loserDelta,
            winnerTier, winnerTierAfter,
            loserTier, loserTierAfter,
            newWinStreak, newLossStreak,
            streakMultiplier, JSON.stringify(badges),
        ],
    );

    return {
        winnerId,
        loserId,
        eloChanges: {
            winner: { oldElo: winner.elo_rating, newElo: winnerNewElo, delta: winnerDelta },
            loser: { oldElo: loser.elo_rating, newElo: loserNewElo, delta: loserDelta },
        },
        tierChanges: {
            winner: winnerTierAfter !== winnerTier ? { before: winnerTier, after: winnerTierAfter } : null,
            loser: loserTierAfter !== loserTier ? { before: loserTier, after: loserTierAfter } : null,
        },
        badgesEarned: badges,
        winnerWinStreak: newWinStreak,
        streakMultiplier,
    };
}

// ── Transaction-safe tier helpers ──

async function getUserTierTx(userId: string, client: PoolClient): Promise<string> {
    const { rows } = await client.query<{ tier: string }>(
        `SELECT tier FROM user_tiers WHERE user_id = $1`,
        [userId],
    );
    return rows[0]?.tier ?? "ROOKIE";
}

async function updateUserTierTx(
    client: PoolClient,
    userId: string,
    newTier: string,
    oldTier: string,
    reason: string,
): Promise<void> {
    await client.query(
        `INSERT INTO user_tiers (user_id, tier, updated_at)
         VALUES ($1, $2, now())
         ON CONFLICT (user_id) DO UPDATE SET tier = $2, updated_at = now()`,
        [userId, newTier],
    );
    await client.query(
        `INSERT INTO user_tier_history (user_id, old_tier, new_tier, reason)
         VALUES ($1, $2, $3, $4)`,
        [userId, oldTier, newTier, reason],
    );
}
