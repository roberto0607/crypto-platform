import { pool } from "../db/pool.js";
import type { PoolClient } from "pg";
import type { TierName, TierRow, TierHistoryRow } from "./competitionTypes.js";

/**
 * Get a user's current tier. Returns 'ROOKIE' if no row exists.
 */
export async function getUserTier(userId: string): Promise<TierName> {
    const { rows } = await pool.query<{ tier: TierName }>(
        `SELECT tier FROM user_tiers WHERE user_id = $1`,
        [userId],
    );
    return rows[0]?.tier ?? "ROOKIE";
}

/**
 * Ensure a user_tiers row exists (upsert ROOKIE if missing).
 * Returns the current row.
 */
export async function ensureUserTier(userId: string): Promise<TierRow> {
    const { rows } = await pool.query<TierRow>(
        `INSERT INTO user_tiers (user_id, tier)
         VALUES ($1, 'ROOKIE')
         ON CONFLICT (user_id) DO NOTHING
         RETURNING user_id, tier, updated_at`,
        [userId],
    );
    if (rows[0]) return rows[0];

    // Row already existed — fetch it
    const { rows: existing } = await pool.query<TierRow>(
        `SELECT user_id, tier, updated_at FROM user_tiers WHERE user_id = $1`,
        [userId],
    );
    return existing[0];
}

/**
 * Update a user's tier and record the change in history.
 * Must be called within a transaction (pass PoolClient).
 */
export async function updateUserTier(
    client: PoolClient,
    userId: string,
    newTier: TierName,
    oldTier: TierName,
    reason: string,
    competitionId?: string,
    weekId?: string,
): Promise<void> {
    // Upsert the tier row
    await client.query(
        `INSERT INTO user_tiers (user_id, tier, updated_at)
         VALUES ($1, $2, now())
         ON CONFLICT (user_id) DO UPDATE SET tier = $2, updated_at = now()`,
        [userId, newTier],
    );

    // Record history
    await client.query(
        `INSERT INTO user_tier_history (user_id, old_tier, new_tier, reason, competition_id, week_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [userId, oldTier, newTier, reason, competitionId ?? null, weekId ?? null],
    );
}

/**
 * Get a user's tier change history, newest first.
 */
export async function getUserTierHistory(
    userId: string,
    limit = 20,
): Promise<TierHistoryRow[]> {
    const { rows } = await pool.query<TierHistoryRow>(
        `SELECT id, user_id, old_tier, new_tier, reason, competition_id, week_id, created_at
         FROM user_tier_history
         WHERE user_id = $1
         ORDER BY created_at DESC
         LIMIT $2`,
        [userId, limit],
    );
    return rows;
}
