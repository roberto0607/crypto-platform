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
                lb.win_rate, lb.consistency, lb.nuanced_score,
                lb.updated_at,
                COALESCE(u.display_name, SPLIT_PART(u.email, '@', 1)) AS display_name,
                COALESCE(ut.tier, 'ROOKIE') AS user_tier,
                COALESCE(cp.qualified, false) AS qualified,
                CASE WHEN ub.id IS NOT NULL THEN true ELSE false END AS has_champion_badge
         FROM competition_leaderboard lb
         JOIN users u ON u.id = lb.user_id
         LEFT JOIN user_tiers ut ON ut.user_id = lb.user_id
         LEFT JOIN competition_participants cp
             ON cp.competition_id = lb.competition_id AND cp.user_id = lb.user_id
         LEFT JOIN user_badges ub
             ON ub.user_id = lb.user_id AND ub.competition_id = lb.competition_id
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
