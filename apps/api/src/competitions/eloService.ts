import type { PoolClient } from "pg";

// ── Trade Wars Tier System (4 tiers) ──

export const TW_TIERS = ["ROOKIE", "PRO", "ELITE", "LEGEND"] as const;
export type TWTier = (typeof TW_TIERS)[number];

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

export interface EloChange {
    winnerDelta: number;
    loserDelta: number;
}

/**
 * Calculate ELO change for a match result.
 * Uses flat tier-based deltas (not classic K-factor formula).
 */
export function calculateEloChange(winnerElo: number, loserElo: number, tier: TWTier): EloChange {
    const table = ELO_TABLE[tier];
    // Upset bonus: if the winner had lower ELO, grant +3 extra
    const upsetBonus = winnerElo < loserElo ? 3 : 0;
    return {
        winnerDelta: table.win + upsetBonus,
        loserDelta: table.lose,
    };
}

/**
 * Apply ELO changes to both players within a transaction.
 * Updates users.elo_rating and inserts elo_history rows.
 */
export async function applyEloChange(
    winnerId: string,
    loserId: string,
    matchId: string,
    tier: TWTier,
    client: PoolClient,
): Promise<EloChange> {
    // Read current ELO for both players (FOR UPDATE to lock rows)
    const { rows: eloRows } = await client.query<{ id: string; elo_rating: number }>(
        `SELECT id, elo_rating FROM users WHERE id = ANY($1) FOR UPDATE`,
        [[winnerId, loserId]],
    );

    const winnerRow = eloRows.find((r) => r.id === winnerId);
    const loserRow = eloRows.find((r) => r.id === loserId);
    if (!winnerRow || !loserRow) throw new Error("user_not_found");

    const change = calculateEloChange(winnerRow.elo_rating, loserRow.elo_rating, tier);

    const newWinnerElo = Math.max(0, winnerRow.elo_rating + change.winnerDelta);
    const newLoserElo = Math.max(0, loserRow.elo_rating + change.loserDelta);

    // Update ELO ratings
    await client.query(
        `UPDATE users SET elo_rating = $1 WHERE id = $2`,
        [newWinnerElo, winnerId],
    );
    await client.query(
        `UPDATE users SET elo_rating = $1 WHERE id = $2`,
        [newLoserElo, loserId],
    );

    // Insert history for winner
    await client.query(
        `INSERT INTO elo_history (user_id, old_elo, new_elo, change_reason, match_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [winnerId, winnerRow.elo_rating, newWinnerElo, "MATCH_WIN", matchId],
    );

    // Insert history for loser
    await client.query(
        `INSERT INTO elo_history (user_id, old_elo, new_elo, change_reason, match_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [loserId, loserRow.elo_rating, newLoserElo, "MATCH_LOSS", matchId],
    );

    return change;
}
