import { pool } from "../db/pool.js";
import type { LeaderboardRow } from "./competitionTypes.js";

export async function getLeaderboard(
    competitionId: string,
    limit = 100,
    offset = 0,
): Promise<LeaderboardRow[]> {
    const { rows } = await pool.query<LeaderboardRow>(
        `SELECT lb.competition_id, lb.user_id, lb.rank, lb.equity, lb.return_pct,
                lb.max_drawdown_pct, lb.current_drawdown_pct, lb.trades_count,
                lb.updated_at,
                SPLIT_PART(u.email, '@', 1) AS display_name
         FROM competition_leaderboard lb
         JOIN users u ON u.id = lb.user_id
         WHERE lb.competition_id = $1
         ORDER BY lb.rank ASC
         LIMIT $2 OFFSET $3`,
        [competitionId, limit, offset],
    );
    return rows;
}

export async function upsertLeaderboardEntry(
    competitionId: string,
    userId: string,
    entry: {
        rank: number;
        equity: string;
        returnPct: string;
        maxDrawdownPct: string;
        currentDrawdownPct: string;
        tradesCount: number;
    },
): Promise<void> {
    await pool.query(
        `INSERT INTO competition_leaderboard
            (competition_id, user_id, rank, equity, return_pct,
             max_drawdown_pct, current_drawdown_pct, trades_count, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
         ON CONFLICT (competition_id, user_id) DO UPDATE SET
            rank = $3, equity = $4, return_pct = $5,
            max_drawdown_pct = $6, current_drawdown_pct = $7,
            trades_count = $8, updated_at = now()`,
        [
            competitionId, userId, entry.rank, entry.equity,
            entry.returnPct, entry.maxDrawdownPct,
            entry.currentDrawdownPct, entry.tradesCount,
        ],
    );
}
