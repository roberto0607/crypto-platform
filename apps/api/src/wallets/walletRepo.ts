import { pool } from "../db/pool";
import type { PoolClient } from "pg";
import { D, toFixed8 } from "../utils/decimal";
import { publish } from "../events/eventBus";
import { createEvent } from "../events/eventTypes";
import { eventsPublishedTotal } from "../metrics";

export type WalletRow = {
    id: string;
    user_id: string;
    asset_id: string;
    balance: string;
    reserved: string;
    created_at: string;
    updated_at: string;
};

export type WalletWithAsset = WalletRow & {
    symbol: string;
    name: string;
};

/* ───── Existing functions (updated SELECTs to include reserved) ───── */

export async function createWallet(userId: string, assetId: string): Promise<WalletRow> {
    const result = await pool.query<WalletRow>(
        `
        INSERT INTO wallets (user_id, asset_id)
        VALUES ($1, $2)
        RETURNING id, user_id, asset_id, balance, reserved, created_at, updated_at
        `,
        [userId, assetId]
    );

    return result.rows[0];
}

export async function listWalletsByUserId(userId: string): Promise<WalletWithAsset[]> {
    const result = await pool.query<WalletWithAsset>(
        `
        SELECT w.id, w.user_id, w.asset_id, w.balance, w.reserved, w.created_at, w.updated_at,
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
        SELECT id, user_id, asset_id, balance, reserved, created_at, updated_at
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
            `SELECT id, user_id, asset_id, balance, reserved, created_at, updated_at
             FROM wallets WHERE id = $1 FOR UPDATE `,
             [walletId]
        );

        const wallet = lockResult.rows[0];
        if (!wallet) {
            throw new Error("wallet_not_found");
        }

        const newBalance = toFixed8(D(wallet.balance).plus(D(amount)));

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

        // Emit wallet.updated (after commit)
        try {
            publish(createEvent("wallet.updated", {
                walletId,
                assetId: wallet.asset_id,
                balance: newBalance,
                reserved: wallet.reserved,
                entryType,
            }, { userId: wallet.user_id }));
            eventsPublishedTotal.inc({ type: "wallet.updated" });
        } catch {
            // Events must never break wallet operations
        }

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
            SELECT id, user_id, asset_id, balance, reserved, created_at, updated_at
            FROM wallets WHERE id = $1 FOR UPDATE`,
            [walletId]
        );

        const wallet = lockResult.rows[0];
        if (!wallet) {
            throw new Error("wallet_not_found");
        }

        if (D(wallet.balance).minus(D(wallet.reserved)).lt(D(amount))) {
            throw new Error("insufficient_balance");
        }

        const newBalance = toFixed8(D(wallet.balance).minus(D(amount)));

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

        // Emit wallet.updated (after commit)
        try {
            publish(createEvent("wallet.updated", {
                walletId,
                assetId: wallet.asset_id,
                balance: newBalance,
                reserved: wallet.reserved,
                entryType,
            }, { userId: wallet.user_id }));
            eventsPublishedTotal.inc({ type: "wallet.updated" });
        } catch {
            // Events must never break wallet operations
        }

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

/* ───── New Phase 4 functions (transaction-aware, take PoolClient) ───── */

export async function findWalletByUserAndAsset(
    client: PoolClient,
    userId: string,
    assetId: string,
): Promise<WalletRow | null> {
    const result = await client.query<WalletRow>(
        `
        SELECT id, user_id, asset_id, balance, reserved, created_at, updated_at
        FROM wallets
        WHERE user_id = $1 AND asset_id = $2
        LIMIT 1
        `,
        [userId, assetId]
    );

    return result.rows[0] ?? null;
}

export async function lockWalletsForUpdate(
    client: PoolClient,
    walletIds: string[]
): Promise<Map<string, WalletRow>> {
    const sorted = [...walletIds].sort();
    const result = await client.query<WalletRow>(
        `
        SELECT id, user_id, asset_id, balance, reserved, created_at, updated_at
        FROM wallets
        WHERE id = ANY($1)
        ORDER BY id
        FOR UPDATE
        `,
        [sorted]
    );

    const map = new Map<string, WalletRow>();
    for (const row of result.rows) {
        map.set(row.id, row);
    }
    return map;
}

export async function reserveFunds(
    client: PoolClient,
    walletId: string,
    amount: string
): Promise<void> {
    await client.query(
        `UPDATE wallets SET reserved = reserved + $1 WHERE id = $2`,
        [amount, walletId]
    );
}

export async function releaseReserved(
    client: PoolClient,
    walletId: string,
    amount: string
): Promise<void> {
    await client.query(
        `UPDATE wallets SET reserved = reserved - $1 WHERE id = $2`,
        [amount, walletId]
    );
}

export async function creditWalletTx(
    client: PoolClient,
    walletId: string,
    amount: string,
    entryType: string,
    refId?: string,
    refType?: string,
    metadata: any = {}
): Promise<void> {
    const newBalance = await client.query<{ balance: string }>(
        `
        UPDATE wallets SET balance = balance + $1
        WHERE id = $2
        RETURNING balance
        `,
        [amount, walletId]
    );

    const balanceAfter = newBalance.rows[0].balance;

    await client.query(
        `
        INSERT INTO ledger_entries (wallet_id, entry_type, amount, balance_after, reference_id, reference_type, metadata)
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
        `,
        [walletId, entryType, amount, balanceAfter, refId ?? null, refType ?? null, JSON.stringify(metadata)]
    );
}

export async function debitAvailableTx(
    client: PoolClient,
    walletId: string,
    amount: string,
    entryType: string,
    refId?: string,
    refType?: string,
    metadata: any = {}
): Promise<void> {
    const result = await client.query<{ balance: string; reserved: string }>(
        `
        SELECT balance, reserved FROM wallets WHERE id = $1
        `,
        [walletId]
    );

    const wallet = result.rows[0];
    const available = D(wallet.balance).minus(D(wallet.reserved));
    if (available.lt(D(amount))) {
        throw new Error("insufficient_balance");
    }

    const newBalance = await client.query<{ balance: string }>(
        `
        UPDATE wallets SET balance = balance - $1
        WHERE id = $2
        RETURNING balance
        `,
        [amount, walletId]
    );

    const balanceAfter = newBalance.rows[0].balance;

    await client.query(
        `
        INSERT INTO ledger_entries (wallet_id, entry_type, amount, balance_after, reference_id, reference_type, metadata)
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
        `,
        [walletId, entryType, `-${amount}`, balanceAfter, refId ?? null, refType ?? null, JSON.stringify(metadata)]
    );
}

export async function consumeReservedAndDebitTx(
    client: PoolClient,
    walletId: string,
    amount: string,
    entryType: string,
    refId?: string,
    refType?: string,
    metadata: any = {}
): Promise<void> {
    const newBalance = await client.query<{ balance: string }>(
        `
        UPDATE wallets SET reserved = reserved - $1, balance = balance - $1
        WHERE id = $2
        RETURNING balance
        `,
        [amount, walletId]
    );

    const balanceAfter = newBalance.rows[0].balance;

    await client.query(
        `
        INSERT INTO ledger_entries (wallet_id, entry_type, amount, balance_after, reference_id, reference_type, metadata)
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
        `,
        [walletId, entryType, `-${amount}`, balanceAfter, refId ?? null, refType ?? null, JSON.stringify(metadata)]
    );
}



