import { pool } from "../db/pool";
import type { PositionRow } from "./positionRepo";
import { D, ZERO, toFixed8 } from "../utils/decimal";
import { getSnapshotForUser } from "../replay/replayEngine";
import { findPairById } from "../trading/pairRepo";

export type PositionWithPnl = PositionRow & {
    unrealized_pnl_quote: string;
    current_price: string;
};

export type PnlSummary = {
    total_realized_pnl: string;
    total_unrealized_pnl: string;
    total_fees_paid: string;
    net_pnl: string;
};

export type EquityPoint = {
    ts: string;
    equity_quote: string;
};

/**
 * Get positions for a user, optionally filtered by pairId.
 * Includes unrealized PnL computed from current snapshot price.
 */
export async function getPositions(
    userId: string,
    pairId?: string,
    competitionId?: string | null,
): Promise<PositionWithPnl[]> {
    const compId = competitionId ?? null;
    const conditions = [`user_id = $1`];
    const params: (string | null)[] = [userId];

    if (pairId) {
        params.push(pairId);
        conditions.push(`pair_id = $${params.length}`);
    }

    if (compId === null) {
        conditions.push(`competition_id IS NULL`);
    } else {
        params.push(compId);
        conditions.push(`competition_id = $${params.length}`);
    }

    conditions.push(`base_qty != 0`);
    const whereClause = `WHERE ${conditions.join(" AND ")}`;

    const result = await pool.query<PositionRow>(
        `
        SELECT user_id, pair_id, base_qty, avg_entry_price, realized_pnl_quote, fees_paid_quote, updated_at
        FROM positions
        ${whereClause}
        ORDER BY updated_at DESC
        `,
        params
    );

    const positions: PositionWithPnl[] = [];

    for (const pos of result.rows) {
        const baseQty = D(pos.base_qty);

        // Get current price from snapshot cascade
        const snapshot = await getSnapshotForUser(userId, pos.pair_id);
        const currentPrice = D(snapshot.last);
        const avgEntry = D(pos.avg_entry_price);
        const unrealized = baseQty.mul(currentPrice.minus(avgEntry));

        positions.push({
            ...pos,
            unrealized_pnl_quote: toFixed8(unrealized),
            current_price: toFixed8(currentPrice),
        });
    }

    return positions;
}

/**
 * Aggregate PnL summary across all positions for a user.
 */
export async function getPnlSummary(userId: string, competitionId?: string | null): Promise<PnlSummary> {
    const positions = await getPositions(userId, undefined, competitionId);

    let totalRealized = ZERO;
    let totalUnrealized = ZERO;
    let totalFees = ZERO;

    for (const pos of positions) {
        totalRealized = totalRealized.plus(D(pos.realized_pnl_quote));
        totalUnrealized = totalUnrealized.plus(D(pos.unrealized_pnl_quote));
        totalFees = totalFees.plus(D(pos.fees_paid_quote));
    }

    const netPnl = totalRealized.plus(totalUnrealized).minus(totalFees);

    return {
        total_realized_pnl: toFixed8(totalRealized),
        total_unrealized_pnl: toFixed8(totalUnrealized),
        total_fees_paid: toFixed8(totalFees),
        net_pnl: toFixed8(netPnl),
    };
}

/**
 * Get equity time series for a user, optionally bounded by from/to epoch ms.
 */
export async function getEquitySeries(
    userId: string,
    from?: number,
    to?: number,
    competitionId?: string | null,
): Promise<EquityPoint[]> {
    const compId = competitionId ?? null;
    let sql = compId === null
        ? `SELECT ts, equity_quote FROM equity_snapshots WHERE user_id = $1 AND competition_id IS NULL`
        : `SELECT ts, equity_quote FROM equity_snapshots WHERE user_id = $1 AND competition_id = $2`;
    const params: (string | number)[] = compId === null ? [userId] : [userId, compId];
    let paramIdx = params.length + 1;

    if (from !== undefined) {
        sql += ` AND ts >= $${paramIdx}`;
        params.push(from);
        paramIdx++;
    }

    if (to !== undefined) {
        sql += ` AND ts <= $${paramIdx}`;
        params.push(to);
        paramIdx++;
    }

    sql += ` ORDER BY ts ASC`;

    const result = await pool.query<{ ts: string; equity_quote: string }>(sql, params);
    return result.rows;
}

/**
 * Paginated equity series for /v1 — keyset on (ts ASC).
 * equity_snapshots PK is (user_id, ts), so ts is unique per user.
 * Fetches limit + 1 rows; caller uses slicePage() to detect next page.
 */
export async function getEquitySeriesPaginated(
    userId: string,
    from: number | undefined,
    to: number | undefined,
    limit: number,
    cursor: { ts: number } | null,
    competitionId?: string | null,
): Promise<EquityPoint[]> {
    const compId = competitionId ?? null;
    let sql = compId === null
        ? `SELECT ts, equity_quote FROM equity_snapshots WHERE user_id = $1 AND competition_id IS NULL`
        : `SELECT ts, equity_quote FROM equity_snapshots WHERE user_id = $1 AND competition_id = $2`;
    const params: (string | number)[] = compId === null ? [userId] : [userId, compId];

    if (from !== undefined) {
        params.push(from);
        sql += ` AND ts >= $${params.length}`;
    }

    if (to !== undefined) {
        params.push(to);
        sql += ` AND ts <= $${params.length}`;
    }

    if (cursor) {
        params.push(cursor.ts);
        sql += ` AND ts > $${params.length}`;
    }

    params.push(limit + 1);
    sql += ` ORDER BY ts ASC LIMIT $${params.length}`;

    const result = await pool.query<{ ts: string; equity_quote: string }>(sql, params);
    return result.rows;
}
