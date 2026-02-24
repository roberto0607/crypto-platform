import { pool } from "../db/pool";
import type { PoolClient } from "pg";

export type PairRow = {
    id: string,
    base_asset_id: string;
    quote_asset_id: string;
    symbol: string;
    is_active: boolean;
    last_price: string | null;
    fee_bps: number;
    created_at: string;
    updated_at: string;
};

const PAIR_COLUMNS = `id, base_asset_id, quote_asset_id, symbol, is_active, last_price, fee_bps, created_at, updated_at`;

export async function createPair(params: {
    baseAssetId: string;
    quoteAssetId: string;
    symbol: string;
    feeBps: number;
}): Promise<PairRow> {
    const result = await pool.query<PairRow>(
        `
        INSERT INTO trading_pairs (base_asset_id, quote_asset_id, symbol, fee_bps)
        VALUES ($1, $2, $3, $4)
        RETURNING ${PAIR_COLUMNS}
        `,
        [params.baseAssetId, params.quoteAssetId, params.symbol, params.feeBps]
    );

    return result.rows[0];
}

export async function findPairById(id: string): Promise<PairRow | null> {
    const result = await pool.query<PairRow>(
        `
        SELECT ${PAIR_COLUMNS}
        FROM trading_pairs
        WHERE id = $1
        LIMIT 1
        `,
        [id]
    );

    return result.rows[0] ?? null;
}

export async function listActivePairs(): Promise<PairRow[]> {
    const result = await pool.query<PairRow>(
        `
        SELECT ${PAIR_COLUMNS}
        FROM trading_pairs
        WHERE is_active = true
        ORDER BY symbol
        `
    );

    return result.rows;
}

export async function setLastPrice(id: string, price: string): Promise<PairRow | null> {
    const result = await pool.query<PairRow>(
        `
        UPDATE trading_pairs SET last_price = $1
        WHERE id = $2
        RETURNING ${PAIR_COLUMNS}
        `,
        [price, id]
    );

    return result.rows[0] ?? null;
}

export async function lockPairForUpdate(client: PoolClient, id: string): Promise<PairRow | null> {
    const result = await client.query<PairRow>(
        `
        SELECT ${PAIR_COLUMNS}
        FROM trading_pairs
        WHERE id = $1
        FOR UPDATE
        `,
        [id]
    );

    return result.rows[0] ?? null;
}