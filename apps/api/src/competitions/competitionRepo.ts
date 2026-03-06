import { pool } from "../db/pool.js";
import type { PoolClient } from "pg";
import type { CompetitionRow } from "./competitionTypes.js";

const COLUMNS = `id, name, description, start_at, end_at, starting_balance_usd,
    status, max_participants, pairs_allowed, created_by, created_at, updated_at`;

export async function createCompetition(
    params: {
        name: string;
        description?: string;
        startAt: string;
        endAt: string;
        startingBalanceUsd?: string;
        maxParticipants?: number;
        pairsAllowed?: "all" | string[];
        createdBy: string;
    },
): Promise<CompetitionRow> {
    const { rows } = await pool.query<CompetitionRow>(
        `INSERT INTO competitions (name, description, start_at, end_at,
            starting_balance_usd, max_participants, pairs_allowed, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
         RETURNING ${COLUMNS}`,
        [
            params.name,
            params.description ?? null,
            params.startAt,
            params.endAt,
            params.startingBalanceUsd ?? "100000.00000000",
            params.maxParticipants ?? null,
            JSON.stringify(params.pairsAllowed ?? "all"),
            params.createdBy,
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
    filters?: { status?: string; limit?: number; offset?: number },
): Promise<{ competitions: CompetitionRow[]; total: number }> {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (filters?.status) {
        params.push(filters.status);
        conditions.push(`status = $${params.length}`);
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
