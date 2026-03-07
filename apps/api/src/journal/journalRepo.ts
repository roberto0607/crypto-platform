import { pool } from "../db/pool";

export interface JournalFilters {
    userId: string;
    pairId?: string;
    competitionId?: string | null;
    direction?: "LONG" | "SHORT";
    pnlSign?: "positive" | "negative";
    from?: string;
    to?: string;
    cursor?: string;
    limit?: number;
}

export interface JournalSummary {
    totalTrades: number;
    winCount: number;
    lossCount: number;
    winRate: string;
    totalGrossPnl: string;
    totalFees: string;
    totalNetPnl: string;
    avgWin: string;
    avgLoss: string;
    largestWin: string;
    largestLoss: string;
    avgHoldingSeconds: number;
    profitFactor: string;
}

export async function listClosedTrades(filters: JournalFilters) {
    const conditions: string[] = ["user_id = $1"];
    const params: unknown[] = [filters.userId];
    let idx = 2;

    if (filters.pairId) {
        conditions.push(`pair_id = $${idx++}`);
        params.push(filters.pairId);
    }
    if (filters.competitionId !== undefined) {
        if (filters.competitionId === null) {
            conditions.push(`competition_id IS NULL`);
        } else {
            conditions.push(`competition_id = $${idx++}`);
            params.push(filters.competitionId);
        }
    }
    if (filters.direction) {
        conditions.push(`direction = $${idx++}`);
        params.push(filters.direction);
    }
    if (filters.pnlSign === "positive") {
        conditions.push(`net_pnl > 0`);
    } else if (filters.pnlSign === "negative") {
        conditions.push(`net_pnl <= 0`);
    }
    if (filters.from) {
        conditions.push(`exit_at >= $${idx++}`);
        params.push(filters.from);
    }
    if (filters.to) {
        conditions.push(`exit_at <= $${idx++}`);
        params.push(filters.to);
    }
    if (filters.cursor) {
        conditions.push(`exit_at < $${idx++}`);
        params.push(filters.cursor);
    }

    const limit = Math.min(filters.limit ?? 50, 100);
    params.push(limit);

    const sql = `
        SELECT ct.*, tp.symbol AS pair_symbol
        FROM closed_trades ct
        JOIN trading_pairs tp ON tp.id = ct.pair_id
        WHERE ${conditions.join(" AND ")}
        ORDER BY exit_at DESC
        LIMIT $${idx}
    `;

    const { rows } = await pool.query(sql, params);
    const nextCursor = rows.length === limit ? rows[rows.length - 1].exit_at : null;
    return { trades: rows, nextCursor };
}

export async function getJournalSummary(
    userId: string,
    competitionId?: string | null,
    pairId?: string,
): Promise<JournalSummary> {
    const conditions: string[] = ["user_id = $1"];
    const params: unknown[] = [userId];
    let idx = 2;

    if (competitionId !== undefined) {
        if (competitionId === null) {
            conditions.push(`competition_id IS NULL`);
        } else {
            conditions.push(`competition_id = $${idx++}`);
            params.push(competitionId);
        }
    }
    if (pairId) {
        conditions.push(`pair_id = $${idx++}`);
        params.push(pairId);
    }

    const where = conditions.join(" AND ");
    const sql = `
        SELECT
            COUNT(*) AS total_trades,
            COUNT(*) FILTER (WHERE net_pnl > 0) AS win_count,
            COUNT(*) FILTER (WHERE net_pnl <= 0) AS loss_count,
            COALESCE(SUM(gross_pnl), 0) AS total_gross_pnl,
            COALESCE(SUM(total_fees), 0) AS total_fees,
            COALESCE(SUM(net_pnl), 0) AS total_net_pnl,
            COALESCE(AVG(net_pnl) FILTER (WHERE net_pnl > 0), 0) AS avg_win,
            COALESCE(AVG(net_pnl) FILTER (WHERE net_pnl <= 0), 0) AS avg_loss,
            COALESCE(MAX(net_pnl), 0) AS largest_win,
            COALESCE(MIN(net_pnl), 0) AS largest_loss,
            COALESCE(AVG(holding_seconds), 0) AS avg_holding_seconds,
            CASE
                WHEN COALESCE(SUM(gross_pnl) FILTER (WHERE gross_pnl < 0), 0) = 0 THEN 0
                ELSE ABS(COALESCE(SUM(gross_pnl) FILTER (WHERE gross_pnl > 0), 0)) /
                     ABS(SUM(gross_pnl) FILTER (WHERE gross_pnl < 0))
            END AS profit_factor
        FROM closed_trades
        WHERE ${where}
    `;

    const { rows } = await pool.query(sql, params);
    const r = rows[0];
    const totalTrades = parseInt(r.total_trades);
    const winCount = parseInt(r.win_count);

    return {
        totalTrades,
        winCount,
        lossCount: parseInt(r.loss_count),
        winRate: totalTrades > 0 ? ((winCount / totalTrades) * 100).toFixed(2) : "0",
        totalGrossPnl: r.total_gross_pnl,
        totalFees: r.total_fees,
        totalNetPnl: r.total_net_pnl,
        avgWin: r.avg_win,
        avgLoss: r.avg_loss,
        largestWin: r.largest_win,
        largestLoss: r.largest_loss,
        avgHoldingSeconds: Math.round(parseFloat(r.avg_holding_seconds)),
        profitFactor: parseFloat(r.profit_factor).toFixed(2),
    };
}
