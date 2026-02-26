import { pool } from "../db/pool";
import type { PoolClient } from "pg";

export type TradeRow = {
    id: string;
    pair_id: string;
    buy_order_id: string | null;
    sell_order_id: string | null;
    price: string;
    qty: string;
    quote_amount: string;
    fee_amount: string;
    fee_asset_id: string | null;
    is_system_fill: boolean;
    executed_at: string;
};

const TRADE_COLUMNS = `id, pair_id, buy_order_id, sell_order_id, price, qty, quote_amount, fee_amount, fee_asset_id, is_system_fill, executed_at`;

export async function createTrade(
    client: PoolClient,
    params: {
        pairId: string;
        buyOrderId: string | null;
        sellOrderId: string | null;
        price: string;
        qty: string;
        quoteAmount: string;
        feeAmount: string;
        feeAssetId: string | null;
        isSystemFill: boolean;
        executedAt?: string;
    }
): Promise<TradeRow> {
    const hasExecutedAt = params.executedAt !== undefined;

    const sql = hasExecutedAt
        ? `
        INSERT INTO trades (pair_id, buy_order_id, sell_order_id, price, qty, quote_amount, fee_amount, fee_asset_id, is_system_fill, executed_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING ${TRADE_COLUMNS}
        `
        : `
        INSERT INTO trades (pair_id, buy_order_id, sell_order_id, price, qty, quote_amount, fee_amount, fee_asset_id, is_system_fill)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING ${TRADE_COLUMNS}
        `;

    const values = [
        params.pairId,
        params.buyOrderId,
        params.sellOrderId,
        params.price,
        params.qty,
        params.quoteAmount,
        params.feeAmount,
        params.feeAssetId,
        params.isSystemFill,
    ];

    if (hasExecutedAt) {
        values.push(params.executedAt!);
    }

    const result = await client.query<TradeRow>(sql, values);
    return result.rows[0];
}

export async function listTradesByOrderId(orderId: string): Promise<TradeRow[]> {
    const result = await pool.query<TradeRow>(
        `
        SELECT ${TRADE_COLUMNS}
        FROM trades
        WHERE buy_order_id = $1 OR sell_order_id = $1
        ORDER BY executed_at ASC
        `,
        [orderId]
    );

    return result.rows;
}
