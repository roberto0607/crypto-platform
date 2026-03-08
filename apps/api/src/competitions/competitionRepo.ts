import { pool } from "../db/pool.js";
import type { PoolClient } from "pg";
import type { CompetitionRow, TierName } from "./competitionTypes.js";

const COLUMNS = `id, name, description, start_at, end_at, starting_balance_usd,
    status, max_participants, pairs_allowed, created_by, created_at, updated_at,
    competition_type, tier, week_id, tier_adjustments_processed`;

export async function createCompetition(
    params: {
        name: string;
        description?: string;
        startAt: string;
        endAt: string;
        startingBalanceUsd?: string;
        maxParticipants?: number;
        pairsAllowed?: "all" | string[];
        createdBy?: string | null;
        competitionType?: "CUSTOM" | "WEEKLY";
        tier?: TierName | null;
        weekId?: string | null;
    },
): Promise<CompetitionRow> {
    const { rows } = await pool.query<CompetitionRow>(
        `INSERT INTO competitions (name, description, start_at, end_at,
            starting_balance_usd, max_participants, pairs_allowed, created_by,
            competition_type, tier, week_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11)
         RETURNING ${COLUMNS}`,
        [
            params.name,
            params.description ?? null,
            params.startAt,
            params.endAt,
            params.startingBalanceUsd ?? "100000.00000000",
            params.maxParticipants ?? null,
            JSON.stringify(params.pairsAllowed ?? "all"),
            params.createdBy ?? null,
            params.competitionType ?? "CUSTOM",
            params.tier ?? null,
            params.weekId ?? null,
        ],
    );
    return rows[0];
}

export async function findCompetitionById(id: string): Promise<CompetitionRow | null> {
    const { rows } = await pool.query<CompetitionRow>(
        `SELECT ${COLUMNS} FROM competitions WHERE id = $1`,
        [id],
    );
    return rows[0] ?? null;
}

export async function lockCompetitionForUpdate(
    client: PoolClient,
    id: string,
): Promise<CompetitionRow | null> {
    const { rows } = await client.query<CompetitionRow>(
        `SELECT ${COLUMNS} FROM competitions WHERE id = $1 FOR UPDATE`,
        [id],
    );
    return rows[0] ?? null;
}

export async function updateCompetitionStatus(
    client: PoolClient,
    id: string,
    status: CompetitionRow["status"],
): Promise<void> {
    await client.query(
        `UPDATE competitions SET status = $1, updated_at = now() WHERE id = $2`,
        [status, id],
    );
}

export async function listCompetitions(
    filters?: {
        status?: string;
        competitionType?: string;
        tier?: string;
        limit?: number;
        offset?: number;
    },
): Promise<{ competitions: CompetitionRow[]; total: number }> {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (filters?.status) {
        params.push(filters.status);
        conditions.push(`status = $${params.length}`);
    }

    if (filters?.competitionType) {
        params.push(filters.competitionType);
        conditions.push(`competition_type = $${params.length}`);
    }

    if (filters?.tier) {
        params.push(filters.tier);
        conditions.push(`tier = $${params.length}`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const countResult = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM competitions ${where}`,
        params,
    );

    const limit = filters?.limit ?? 50;
    const offset = filters?.offset ?? 0;
    params.push(limit, offset);

    const { rows } = await pool.query<CompetitionRow>(
        `SELECT ${COLUMNS} FROM competitions ${where}
         ORDER BY start_at DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
    );

    return { competitions: rows, total: parseInt(countResult.rows[0].count) };
}

export async function listUpcomingToActivate(): Promise<CompetitionRow[]> {
    const { rows } = await pool.query<CompetitionRow>(
        `SELECT ${COLUMNS} FROM competitions
         WHERE status = 'UPCOMING' AND start_at <= now()`,
    );
    return rows;
}

export async function listActiveToEnd(): Promise<CompetitionRow[]> {
    const { rows } = await pool.query<CompetitionRow>(
        `SELECT ${COLUMNS} FROM competitions
         WHERE status = 'ACTIVE' AND end_at <= now()`,
    );
    return rows;
}

export async function listActiveCompetitions(): Promise<CompetitionRow[]> {
    const { rows } = await pool.query<CompetitionRow>(
        `SELECT ${COLUMNS} FROM competitions WHERE status = 'ACTIVE'`,
    );
    return rows;
}

// ── Weekly competition queries ──

/**
 * Find a weekly competition by tier and week_id.
 * Uses the unique index idx_competitions_weekly_tier_week.
 */
export async function findWeeklyCompetition(
    tier: TierName,
    weekId: string,
): Promise<CompetitionRow | null> {
    const { rows } = await pool.query<CompetitionRow>(
        `SELECT ${COLUMNS} FROM competitions
         WHERE competition_type = 'WEEKLY' AND tier = $1 AND week_id = $2`,
        [tier, weekId],
    );
    return rows[0] ?? null;
}

/**
 * List all weekly competitions for a given week (all 6 tiers).
 */
export async function listWeeklyCompetitionsForWeek(
    weekId: string,
): Promise<CompetitionRow[]> {
    const { rows } = await pool.query<CompetitionRow>(
        `SELECT ${COLUMNS} FROM competitions
         WHERE competition_type = 'WEEKLY' AND week_id = $1
         ORDER BY tier ASC`,
        [weekId],
    );
    return rows;
}

/**
 * Find ended weekly competitions that haven't had tier adjustments processed.
 */
export async function listEndedUnprocessedWeekly(): Promise<CompetitionRow[]> {
    const { rows } = await pool.query<CompetitionRow>(
        `SELECT ${COLUMNS} FROM competitions
         WHERE competition_type = 'WEEKLY'
           AND status = 'ENDED'
           AND tier_adjustments_processed = false`,
    );
    return rows;
}

/**
 * Mark a competition's tier adjustments as processed.
 */
export async function markTierAdjustmentsProcessed(
    client: PoolClient,
    competitionId: string,
): Promise<void> {
    await client.query(
        `UPDATE competitions SET tier_adjustments_processed = true, updated_at = now()
         WHERE id = $1`,
        [competitionId],
    );
}
