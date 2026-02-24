import { pool } from "../db/pool";
import type { PoolClient } from "pg";

export type OrderRow = {
    id: string;
    user_id: string;
    pair_id: string;
    side: string;
    type: string;
    limit_price: string | null;
    qty: string;
    qty_filled: string;
    status: string;
    reserved_wallet_id: string | null;
    reserved_amount: string;
    reserved_consumed: string;
    created_at: string;
    updated_at: string;
};

const ORDER_COLUMNS = `id, user_id, pair_id, side, type, limit_price, qty, qty_filled, status, reserved_wallet_id, reserved_amount, reserved_consumed, created_at, updated_at`;

export async function createOrder(
    client: PoolClient,
    params: {
        userId: string;
        pairId: string;
        side: string;
        type: string;
        limitPrice: string | null;
        qty: string;
        status: string;
        reservedWalletId: string | null;
        reservedAmount: string;
    }
): Promise<OrderRow> {
    const result = await client.query<OrderRow>(
        `
        INSERT INTO orders (user_id, pair_id, side, type, limit_price, qty, status, reserved_wallet_id, reserved_amount)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING ${ORDER_COLUMNS}
        `,
        [
            params.userId,
            params.pairId,
            params.side,
            params.type,
            params.limitPrice,
            params.qty,
            params.status,
            params.reservedWalletId,
            params.reservedAmount,
        ]
    );

    return result.rows[0];
}

export async function findOrderById(id: string): Promise<OrderRow | null> {
    const result = await pool.query<OrderRow>(
        `
        SELECT ${ORDER_COLUMNS}
        FROM orders
        WHERE id = $1
        LIMIT 1
        `,
        [id]
    );

    return result.rows[0] ?? null;
}

export async function findOrderByIdForUpdate(client: PoolClient, id: string): Promise<OrderRow | null> {
    const result = await client.query<OrderRow>(
        `
        SELECT ${ORDER_COLUMNS}
        FROM orders
        WHERE id = $1
        FOR UPDATE
        `,
        [id]
    );

    return result.rows[0] ?? null;
}

export async function listOrdersByUserId(
    userId: string,
    filters?: { pairId?: string; status?: string }
): Promise<OrderRow[]> {
    let query = `SELECT ${ORDER_COLUMNS} FROM orders WHERE user_id = $1`;
    const params: any[] = [userId];

    if (filters?.pairId) {
        params.push(filters.pairId);
        query += ` AND pair_id = $${params.length}`;
    }

    if (filters?.status) {
        params.push(filters.status);
        query += ` AND status = $${params.length}`;
    }

    query += ` ORDER BY created_at DESC`;

    const result = await pool.query<OrderRow>(query, params);
    return result.rows;
}

export async function updateOrderFill(
    client: PoolClient,
    orderId: string,
    addQtyFilled: string,
    addReservedConsumed: string,
    newStatus: string
): Promise<OrderRow> {
    const result = await client.query<OrderRow>(
        `
        UPDATE orders
        SET qty_filled = qty_filled + $1,
            reserved_consumed = reserved_consumed + $2,
            status = $3
        WHERE id = $4
        RETURNING ${ORDER_COLUMNS}
        `,
        [addQtyFilled, addReservedConsumed, newStatus, orderId]
    );

    return result.rows[0];
}

    export async function setOrderStatus(
        client: PoolClient,
        orderId: string,
        status: string
    ): Promise<OrderRow> {
        const result = await client.query<OrderRow>(
            `
            UPDATE orders SET status = $1 WHERE id = $2
            RETURNING ${ORDER_COLUMNS}
            `,
            [status, orderId]
        );

        return result.rows[0];
    }

    export async function getRestingSellOrders(client: PoolClient, pairId: string): Promise<OrderRow[]> {
        const result = await client.query<OrderRow>(
            `
            SELECT ${ORDER_COLUMNS}
            FROM orders
            WHERE pair_id = $1
                AND side = 'SELL'
                AND status IN ('OPEN', 'PARTIALLY_FILLED')
                AND type = 'LIMIT'
            ORDER BY limit_price ASC, created_at ASC
            `,
            [pairId]
        );

        return result.rows;
    }

    export async function getRestingBuyOrders(client: PoolClient, pairId: string): Promise<OrderRow[]> {
        const result = await client.query<OrderRow>(
            `
            SELECT ${ORDER_COLUMNS}
            FROM orders
            WHERE pair_id = $1
                AND side = 'BUY'
                AND status IN ('OPEN', 'PARTIALLY_FILLED')
                AND type = 'LIMIT'
            ORDER BY limit_price DESC, created_at ASC
            `,
            [pairId]
        );

        return result.rows;
    }

