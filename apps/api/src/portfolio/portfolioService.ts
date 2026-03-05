import type { PoolClient } from "pg";
import { pool } from "../db/pool";
import { D, ZERO, toFixed8 } from "../utils/decimal";
import { getPositions } from "../analytics/pnlService";
import { getSnapshotForUser } from "../replay/replayEngine";
import { logger } from "../observability/logContext";
import type { PortfolioSummary, PortfolioSnapshot, PerformanceSummary } from "./portfolioTypes";
import type { EquityEntry } from "./performance";
import {
    computeTotalReturn,
    computeMaxDrawdown,
    computeCurrentDrawdown,
    computeDrawdownSeries,
} from "./performance";

const MAX_PERFORMANCE_POINTS = 10000;

// ── Helpers ──────────────────────────────────────────────

async function getQuoteAssetIds(): Promise<string[]> {
    const { rows } = await pool.query<{ quote_asset_id: string }>(
        `SELECT DISTINCT quote_asset_id FROM trading_pairs WHERE is_active = true`,
    );
    return rows.map((r) => r.quote_asset_id);
}

// ── Public API ───────────────────────────────────────────

/**
 * Live portfolio summary from wallets + positions + mark prices.
 */
export async function getPortfolioSummary(
    userId: string,
    pairId?: string,
): Promise<PortfolioSummary> {
    // 1. Cash (sum of quote-asset wallets)
    const quoteAssetIds = await getQuoteAssetIds();
    let cashQuote = ZERO;
    if (quoteAssetIds.length > 0) {
        const { rows } = await pool.query<{ total: string }>(
            `SELECT COALESCE(SUM(balance), 0) AS total
             FROM wallets
             WHERE user_id = $1 AND asset_id = ANY($2)`,
            [userId, quoteAssetIds],
        );
        cashQuote = D(rows[0].total);
    }

    // 2. Positions (with unrealized PnL + current_price via pnlService)
    const positions = await getPositions(userId, pairId);

    let holdingsQuote = ZERO;
    let unrealizedPnl = ZERO;
    let realizedPnl = ZERO;
    let feesPaid = ZERO;

    for (const pos of positions) {
        const baseQty = D(pos.base_qty);
        holdingsQuote = holdingsQuote.plus(baseQty.mul(D(pos.current_price)));
        unrealizedPnl = unrealizedPnl.plus(D(pos.unrealized_pnl_quote));
        realizedPnl = realizedPnl.plus(D(pos.realized_pnl_quote));
        feesPaid = feesPaid.plus(D(pos.fees_paid_quote));
    }

    const equityQuote = cashQuote.plus(holdingsQuote);
    const netPnl = realizedPnl.plus(unrealizedPnl).minus(feesPaid);

    return {
        cash_quote: toFixed8(cashQuote),
        holdings_quote: toFixed8(holdingsQuote),
        equity_quote: toFixed8(equityQuote),
        realized_pnl_quote: toFixed8(realizedPnl),
        unrealized_pnl_quote: toFixed8(unrealizedPnl),
        fees_paid_quote: toFixed8(feesPaid),
        net_pnl_quote: toFixed8(netPnl),
    };
}

/**
 * Paginated equity curve from equity_snapshots (v2 columns).
 * Keyset pagination on ts ASC. Fetches limit + 1 rows for slicePage().
 */
export async function getEquityCurve(
    userId: string,
    from: number | undefined,
    to: number | undefined,
    limit: number,
    cursor: { ts: number } | null,
): Promise<PortfolioSnapshot[]> {
    let sql = `SELECT ts, equity_quote, cash_quote, holdings_quote,
                      unrealized_pnl_quote, realized_pnl_quote, fees_paid_quote
               FROM equity_snapshots WHERE user_id = $1`;
    const params: (string | number)[] = [userId];

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

    const { rows } = await pool.query<PortfolioSnapshot>(sql, params);
    return rows;
}

/**
 * Performance analytics computed from the equity curve.
 */
export async function getPerformance(
    userId: string,
    from: number | undefined,
    to: number | undefined,
): Promise<PerformanceSummary> {
    let sql = `SELECT ts, equity_quote FROM equity_snapshots WHERE user_id = $1`;
    const params: (string | number)[] = [userId];

    if (from !== undefined) {
        params.push(from);
        sql += ` AND ts >= $${params.length}`;
    }
    if (to !== undefined) {
        params.push(to);
        sql += ` AND ts <= $${params.length}`;
    }

    params.push(MAX_PERFORMANCE_POINTS);
    sql += ` ORDER BY ts ASC LIMIT $${params.length}`;

    const { rows } = await pool.query<EquityEntry>(sql, params);

    const totalReturn = computeTotalReturn(rows);
    const maxDd = computeMaxDrawdown(rows);
    const currentDd = computeCurrentDrawdown(rows);
    const ddSeries = computeDrawdownSeries(rows);

    return {
        total_return_pct: toFixed8(totalReturn),
        max_drawdown_pct: toFixed8(maxDd),
        current_drawdown_pct: toFixed8(currentDd),
        equity_start: rows.length > 0 ? rows[0].equity_quote : "0.00000000",
        equity_end: rows.length > 0 ? rows[rows.length - 1].equity_quote : "0.00000000",
        data_points: rows.length,
        drawdown_series: ddSeries,
    };
}

/**
 * Write a rich portfolio snapshot after a fill.
 * Called post-commit from phase6OrderService (fire-and-forget).
 *
 * Uses fillPrice as mark for the traded pair; getSnapshotForUser for others.
 * Overwrites the narrow snapshot written by positionRepo (same PK).
 */
export async function writePortfolioSnapshot(
    userId: string,
    ts: number,
    fillPairId: string,
    fillPrice: string,
): Promise<void> {
    // 1. Quote asset IDs
    const quoteAssetIds = await getQuoteAssetIds();

    // 2. Cash
    let cashQuote = ZERO;
    if (quoteAssetIds.length > 0) {
        const { rows } = await pool.query<{ total: string }>(
            `SELECT COALESCE(SUM(balance), 0) AS total
             FROM wallets WHERE user_id = $1 AND asset_id = ANY($2)`,
            [userId, quoteAssetIds],
        );
        cashQuote = D(rows[0].total);
    }

    // 3. All positions for this user
    const { rows: posRows } = await pool.query<{
        pair_id: string;
        base_qty: string;
        avg_entry_price: string;
        realized_pnl_quote: string;
        fees_paid_quote: string;
    }>(
        `SELECT pair_id, base_qty, avg_entry_price, realized_pnl_quote, fees_paid_quote
         FROM positions WHERE user_id = $1`,
        [userId],
    );

    let holdingsQuote = ZERO;
    let unrealizedPnl = ZERO;
    let realizedPnl = ZERO;
    let feesPaid = ZERO;

    for (const pos of posRows) {
        realizedPnl = realizedPnl.plus(D(pos.realized_pnl_quote));
        feesPaid = feesPaid.plus(D(pos.fees_paid_quote));

        const baseQty = D(pos.base_qty);
        if (baseQty.eq(ZERO)) continue;

        // Mark price: fill price for the traded pair, snapshot for others
        let markPrice;
        if (pos.pair_id === fillPairId) {
            markPrice = D(fillPrice);
        } else {
            const snap = await getSnapshotForUser(userId, pos.pair_id);
            markPrice = D(snap.last);
        }

        holdingsQuote = holdingsQuote.plus(baseQty.mul(markPrice));
        unrealizedPnl = unrealizedPnl.plus(
            baseQty.mul(markPrice.minus(D(pos.avg_entry_price))),
        );
    }

    const equityQuote = cashQuote.plus(holdingsQuote);

    // 4. Upsert (overwrites narrow snapshot from positionRepo)
    await pool.query(
        `INSERT INTO equity_snapshots
             (user_id, ts, equity_quote, cash_quote, holdings_quote,
              unrealized_pnl_quote, realized_pnl_quote, fees_paid_quote)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (user_id, ts) DO UPDATE SET
             equity_quote = $3,
             cash_quote = $4,
             holdings_quote = $5,
             unrealized_pnl_quote = $6,
             realized_pnl_quote = $7,
             fees_paid_quote = $8`,
        [
            userId, ts, toFixed8(equityQuote),
            toFixed8(cashQuote), toFixed8(holdingsQuote),
            toFixed8(unrealizedPnl), toFixed8(realizedPnl), toFixed8(feesPaid),
        ],
    );

    logger.debug({ userId, ts, equity: toFixed8(equityQuote) }, "portfolio_snapshot_written");
}

/**
 * Write a rich portfolio snapshot within a caller-managed transaction.
 * Uses the provided PoolClient so it sees uncommitted changes (wallets, positions)
 * from the same transaction.
 *
 * Keep writePortfolioSnapshot() above for backward compatibility (portfolio-sampling job).
 */
export async function writePortfolioSnapshotTx(
    client: PoolClient,
    userId: string,
    ts: number,
    fillPairId: string,
    fillPrice: string,
): Promise<void> {
    // 1. Quote asset IDs
    const { rows: qaRows } = await client.query<{ quote_asset_id: string }>(
        `SELECT DISTINCT quote_asset_id FROM trading_pairs WHERE is_active = true`,
    );
    const quoteAssetIds = qaRows.map((r) => r.quote_asset_id);

    // 2. Cash
    let cashQuote = ZERO;
    if (quoteAssetIds.length > 0) {
        const { rows } = await client.query<{ total: string }>(
            `SELECT COALESCE(SUM(balance), 0) AS total
             FROM wallets WHERE user_id = $1 AND asset_id = ANY($2)`,
            [userId, quoteAssetIds],
        );
        cashQuote = D(rows[0].total);
    }

    // 3. All positions for this user
    const { rows: posRows } = await client.query<{
        pair_id: string;
        base_qty: string;
        avg_entry_price: string;
        realized_pnl_quote: string;
        fees_paid_quote: string;
    }>(
        `SELECT pair_id, base_qty, avg_entry_price, realized_pnl_quote, fees_paid_quote
         FROM positions WHERE user_id = $1`,
        [userId],
    );

    let holdingsQuote = ZERO;
    let unrealizedPnl = ZERO;
    let realizedPnl = ZERO;
    let feesPaid = ZERO;

    for (const pos of posRows) {
        realizedPnl = realizedPnl.plus(D(pos.realized_pnl_quote));
        feesPaid = feesPaid.plus(D(pos.fees_paid_quote));

        const baseQty = D(pos.base_qty);
        if (baseQty.eq(ZERO)) continue;

        // Mark price: fill price for the traded pair, snapshot for others
        let markPrice;
        if (pos.pair_id === fillPairId) {
            markPrice = D(fillPrice);
        } else {
            const snap = await getSnapshotForUser(userId, pos.pair_id);
            markPrice = D(snap.last);
        }

        holdingsQuote = holdingsQuote.plus(baseQty.mul(markPrice));
        unrealizedPnl = unrealizedPnl.plus(
            baseQty.mul(markPrice.minus(D(pos.avg_entry_price))),
        );
    }

    const equityQuote = cashQuote.plus(holdingsQuote);

    // 4. Upsert (overwrites narrow snapshot from positionRepo)
    await client.query(
        `INSERT INTO equity_snapshots
             (user_id, ts, equity_quote, cash_quote, holdings_quote,
              unrealized_pnl_quote, realized_pnl_quote, fees_paid_quote)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (user_id, ts) DO UPDATE SET
             equity_quote = $3,
             cash_quote = $4,
             holdings_quote = $5,
             unrealized_pnl_quote = $6,
             realized_pnl_quote = $7,
             fees_paid_quote = $8`,
        [
            userId, ts, toFixed8(equityQuote),
            toFixed8(cashQuote), toFixed8(holdingsQuote),
            toFixed8(unrealizedPnl), toFixed8(realizedPnl), toFixed8(feesPaid),
        ],
    );

    logger.debug({ userId, ts, equity: toFixed8(equityQuote) }, "portfolio_snapshot_written_tx");
}
