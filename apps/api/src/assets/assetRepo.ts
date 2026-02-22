import { pool } from "../db/pool";

export type AssetRow = {
    id: string;
    symbol: string;
    name: string;
    decimals: number;
    is_active: boolean;
    created_at: string;
};

export async function createAsset(params: {
    symbol: string;
    name: string;
    decimals: number;
}): Promise<AssetRow> {
    const { symbol, name, decimals } = params;

    const result = await pool.query<AssetRow>(
        `
        INSERT INTO assets (symbol, name, decimals)
        VALUES ($1, $2, $3)
        RETURNING id, symbol, name, decimals, is_active, created_at
        `,
        [symbol, name, decimals]
    );

    return result.rows[0];
}

export async function findAssetById(id: string): Promise<AssetRow | null> {
    const result = await pool.query<AssetRow>(
        `
        SELECT id, symbol, name, decimals, is_active, created_at
        FROM assets
        WHERE id = $1
        LIMIT 1
        `,
        [id]
    );

    return result.rows[0] ?? null;
}

export async function listActiveAssets(): Promise<AssetRow[]> {
    const result = await pool.query<AssetRow>(
        `
        SELECT id, symbol, name, decimals, is_active, created_at
        FROM assets
        WHERE is_active = true
        ORDER BY symbol
        `
    );

    return result.rows;
}