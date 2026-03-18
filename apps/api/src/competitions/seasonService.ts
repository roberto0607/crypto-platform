import { pool } from "../db/pool.js";
import type { TWTier } from "./eloService.js";

// ── Constants ──

const SEASON_DURATION_DAYS = 28;
const OFF_SEASON_DAYS = 3;

const TIER_CAPITAL: Record<TWTier, number> = {
    ROOKIE:  50_000,
    PRO:     100_000,
    ELITE:   250_000,
    LEGEND:  1_000_000,
};

export interface SeasonRow {
    id: string;
    name: string;
    description: string | null;
    start_at: string;
    end_at: string;
    starting_balance_usd: string;
    status: string;
    tier: string | null;
    season_number: number | null;
    off_season_ends: string | null;
    competition_type: string;
}

/**
 * Get the current active season for any tier, or null if off-season / no season.
 */
export async function getCurrentSeason(tier?: TWTier): Promise<SeasonRow | null> {
    const query = tier
        ? `SELECT * FROM competitions
           WHERE competition_type = 'SEASON' AND status = 'ACTIVE' AND tier = $1
           LIMIT 1`
        : `SELECT * FROM competitions
           WHERE competition_type = 'SEASON' AND status = 'ACTIVE'
           ORDER BY start_at DESC LIMIT 1`;
    const params = tier ? [tier] : [];
    const { rows } = await pool.query<SeasonRow>(query, params);
    return rows[0] ?? null;
}

/**
 * Create a new 28-day season for a specific tier.
 * Automatically sets starting capital based on tier.
 */
export async function createNewSeason(
    tier: TWTier,
    seasonNumber: number,
    startAt?: Date,
): Promise<SeasonRow> {
    const start = startAt ?? new Date();
    const end = new Date(start.getTime() + SEASON_DURATION_DAYS * 86_400_000);
    const offSeasonEnds = new Date(end.getTime() + OFF_SEASON_DAYS * 86_400_000);
    const capital = TIER_CAPITAL[tier];

    const name = `Season ${seasonNumber} - ${tier}`;
    const description = `Trade Wars Season ${seasonNumber} for ${tier} tier. ${SEASON_DURATION_DAYS}-day competition.`;

    const { rows } = await pool.query<SeasonRow>(
        `INSERT INTO competitions
           (name, description, start_at, end_at, starting_balance_usd, status,
            competition_type, tier, season_number, off_season_ends)
         VALUES ($1, $2, $3, $4, $5, 'ACTIVE', 'SEASON', $6, $7, $8)
         RETURNING *`,
        [name, description, start.toISOString(), end.toISOString(), capital, tier, seasonNumber, offSeasonEnds.toISOString()],
    );
    return rows[0];
}

/**
 * Check if we're currently in the off-season (between season end and next season start).
 */
export async function isOffSeason(): Promise<boolean> {
    const { rows } = await pool.query<{ off_season_ends: string }>(
        `SELECT off_season_ends FROM competitions
         WHERE competition_type = 'SEASON' AND status = 'ENDED'
           AND off_season_ends > now()
         ORDER BY end_at DESC LIMIT 1`,
    );
    return rows.length > 0;
}

/**
 * Get the latest season number across all tiers.
 */
export async function getLatestSeasonNumber(): Promise<number> {
    const { rows } = await pool.query<{ max: string | null }>(
        `SELECT max(season_number) FROM competitions WHERE competition_type = 'SEASON'`,
    );
    return rows[0]?.max ? parseInt(rows[0].max, 10) : 0;
}
