import { pool } from "../db/pool.js";
import type { BadgeRow } from "./competitionTypes.js";

/**
 * Award a badge to a user. Idempotent via ON CONFLICT DO NOTHING.
 */
export async function awardBadge(params: {
    userId: string;
    badgeType: string;
    tier: string;
    weekId: string;
    competitionId: string;
    metadata?: Record<string, unknown>;
}): Promise<BadgeRow | null> {
    const { rows } = await pool.query<BadgeRow>(
        `INSERT INTO user_badges (user_id, badge_type, tier, week_id, competition_id, metadata)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)
         ON CONFLICT (user_id, badge_type, week_id, tier) DO NOTHING
         RETURNING *`,
        [
            params.userId,
            params.badgeType,
            params.tier,
            params.weekId,
            params.competitionId,
            JSON.stringify(params.metadata ?? {}),
        ],
    );
    return rows[0] ?? null;
}

/**
 * Get all badges for a user, newest first.
 */
export async function getUserBadges(userId: string): Promise<BadgeRow[]> {
    const { rows } = await pool.query<BadgeRow>(
        `SELECT id, user_id, badge_type, tier, week_id, competition_id, metadata, earned_at
         FROM user_badges
         WHERE user_id = $1
         ORDER BY earned_at DESC`,
        [userId],
    );
    return rows;
}
