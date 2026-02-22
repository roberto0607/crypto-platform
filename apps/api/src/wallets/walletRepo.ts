import { pool } from "../db/pool";

export type WalletRow = {
    id: string;
    user_id: string;
    asset_id: string;
    balance: string;
    created_at: string;
    updated_at: string;
};

export type WalletWithAsset = WalletRow & {
    symbol: string;
    name: string;
};

export async function createWallet(userId: string, assetId: string): Promise<WalletRow> {
    const result = await pool.query<WalletRow>(
        `
        INSERT INTO wallets (user_id, asset_id)
        VALUES ($1, $2)
        RETURNING id, user_id, asset_id, balance, created_at, updated_at
        `,
        [userId, assetId]
    );

    return result.rows[0];
}

export async function listWalletsByUserId(userId: string): Promise<WalletWithAsset[]> {
    const result = await pool.query<WalletWithAsset>(
        `
        SELECT w.id, w.user_id, w.asset_id, w.balance, w.created_at, w.updated_at,
               a.symbol, a.name
        FROM wallets w
        JOIN assets a ON a.id = w.asset_id
        WHERE w.user_id = $1
        ORDER BY a.symbol
        `,
        [userId]
    );

    return result.rows;
}

export async function findWalletById(id: string): Promise<WalletRow | null> {
    const result = await pool.query<WalletRow>(
        `
        SELECT id, user_id, asset_id, balance, created_at, updated_at
        FROM wallets
        WHERE id = $1
        LIMIT 1
        `,
        [id]
    );

    return result.rows[0] ?? null;
}

export async function creditWallet(
    walletId: string,
    amount: string,
    entryType: string,
    metadata: any = {}
): Promise<{ wallet: WalletRow; ledgerEntryId: string }> {
    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        const lockResult = await client.query<WalletRow>(
            `SELECT id, user_id, asset_id, balance, created_at, updated_at
             FROM wallets WHERE id = $1 FOR UPDATE `,
             [walletId]
        );

        const wallet = lockResult.rows[0];
        if (!wallet) {
            throw new Error("wallet_not_found");
        }

        const newBalance = (parseFloat(wallet.balance) + parseFloat(amount)).toFixed(8);

        await client.query(
            `UPDATE wallets SET balance = $1 WHERE id = $2`,
            [newBalance, walletId]
        );

        const ledgerResult = await client.query<{ id: string }>(
            `
            INSERT INTO ledger_entries (wallet_id, entry_type, amount, balance_after, metadata)
            VALUES ($1, $2, $3, $4, $5::jsonb)
            RETURNING id`,
            [walletId, entryType, amount, newBalance, JSON.stringify(metadata)]
        );

        await client.query("COMMIT");

        return {
            wallet: { ...wallet, balance: newBalance },
            ledgerEntryId: ledgerResult.rows[0].id,
        };
    } catch (err) {
        await client.query("ROLLBACK");
        throw err;
    } finally {
        client.release();
    }
}

export async function debitWallet(
    walletId: string,
    amount: string,
    entryType: string,
    metadata: any = {}
): Promise<{ wallet: WalletRow; ledgerEntryId: string }> {
    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        const lockResult = await client.query<WalletRow>(
            `
            SELECT id, user_id, asset_id, balance, created_at, updated_at
            FROM wallets WHERE id = $1 FOR UPDATE`,
            [walletId]
        );

        const wallet = lockResult.rows[0];
        if (!wallet) {
            throw new Error("wallet_not_found");
        }

        if (parseFloat(wallet.balance) < parseFloat(amount)) {
            throw new Error("insufficient_balance");
        }

        const newBalance = (parseFloat(wallet.balance) - parseFloat(amount)).toFixed(8);

        await client.query(
            `
            UPDATE wallets SET balance = $1 WHERE id = $2`,
            [newBalance, walletId]
        );

        const ledger = await client.query<{ id: string }>(
            `
            INSERT INTO ledger_entries (wallet_id, entry_type, amount, balance_after, metadata)
            VALUES ($1, $2, $3, $4, $5::jsonb)
            RETURNING id`,
            [walletId, entryType, `-${amount}`, newBalance, JSON.stringify(metadata)]
        );

        await client.query("COMMIT");

        return {
            wallet: {...wallet, balance: newBalance },
            ledgerEntryId: ledger.rows[0].id,
        };
    } catch (err) {
        await client.query("ROLLBACK");
        throw err;
    } finally {
        client.release();
    }
}



