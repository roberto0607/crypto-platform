import { pool, acquireClient } from "../db/pool";
import type { PoolClient } from "pg";
import { D, toFixed8 } from "../utils/decimal";
import { publish } from "../events/eventBus";
import { createEvent, type AppEvent } from "../events/eventTypes";
import { eventsPublishedTotal } from "../metrics";
import { timedQuery } from "../observability/dbTiming";

export type WalletRow = {
    id: string;
    user_id: string;
    asset_id: string;
    balance: string;
    reserved: string;
    created_at: string;
    updated_at: string;
    /** Set on a match's wallets (migration 095); null for free-play / competition. */
    match_id?: string | null;
    /** Set when the match ended: final balances kept, no more orders. */
    closed_at?: string | null;
};

/**
 * Which account a wallet belongs to. Exactly one applies:
 *   matchId set       → that 1v1 match's wallets (funded at accept, closed at end)
 *   competitionId set → that competition's wallets
 *   both null         → free-play
 * Free-play and competition lookups always add `match_id IS NULL`, so a
 * match's wallets never leak into them.
 */
export type WalletScope = { competitionId?: string | null; matchId?: string | null };

/** SQL predicate + params for `scope`, numbering params from `$${first}`. */
export function walletScopeFilter(scope: WalletScope, first: number, alias = ""): { sql: string; params: string[] } {
    const col = (c: string) => (alias ? `${alias}.${c}` : c);
    if (scope.matchId) return { sql: `${col("match_id")} = $${first}`, params: [scope.matchId] };
    if (scope.competitionId) {
        return { sql: `${col("competition_id")} = $${first} AND ${col("match_id")} IS NULL`, params: [scope.competitionId] };
    }
    return { sql: `${col("competition_id")} IS NULL AND ${col("match_id")} IS NULL`, params: [] };
}

const WALLET_COLUMNS = `id, user_id, asset_id, balance, reserved, created_at, updated_at, match_id, closed_at`;

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

export async function listWalletsByUserId(
    userId: string,
    competitionId?: string | null,
): Promise<WalletWithAsset[]> {
    const f = walletScopeFilter({ competitionId }, 2, "w");
    const result = await pool.query<WalletWithAsset>(
        `SELECT w.id, w.user_id, w.asset_id, w.balance, w.reserved, w.created_at, w.updated_at,
                a.symbol, a.name
         FROM wallets w
         JOIN assets a ON a.id = w.asset_id
         WHERE w.user_id = $1 AND ${f.sql}
         ORDER BY a.symbol`,
        [userId, ...f.params],
    );

    return result.rows;
}

/** One player's wallets in a match (open or closed), with asset symbols. */
export async function listMatchWalletsForUser(userId: string, matchId: string): Promise<(WalletWithAsset & { match_id: string; closed_at: string | null })[]> {
    const result = await pool.query<WalletWithAsset & { match_id: string; closed_at: string | null }>(
        `SELECT w.id, w.user_id, w.asset_id, w.balance, w.reserved, w.created_at, w.updated_at,
                w.match_id, w.closed_at, a.symbol, a.name
         FROM wallets w
         JOIN assets a ON a.id = w.asset_id
         WHERE w.user_id = $1 AND w.match_id = $2
         ORDER BY a.symbol`,
        [userId, matchId],
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
    const client = await acquireClient();

    try {
        await client.query("BEGIN");

        const lockResult = await timedQuery<WalletRow>(client, "walletRepo.creditWallet.lock",
            `SELECT id, user_id, asset_id, balance, reserved, created_at, updated_at
             FROM wallets WHERE id = $1 FOR UPDATE `,
             [walletId]
        );

        const wallet = lockResult.rows[0];
        if (!wallet) {
            throw new Error("wallet_not_found");
        }

        const newBalance = toFixed8(D(wallet.balance).plus(D(amount)));

        await timedQuery(client, "walletRepo.creditWallet.update",
            `UPDATE wallets SET balance = $1 WHERE id = $2`,
            [newBalance, walletId]
        );

        const ledgerResult = await timedQuery<{ id: string }>(client, "walletRepo.creditWallet.ledger",
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
    const client = await acquireClient();

    try {
        await client.query("BEGIN");

        const lockResult = await timedQuery<WalletRow>(client, "walletRepo.debitWallet.lock",
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

        await timedQuery(client, "walletRepo.debitWallet.update",
            `
            UPDATE wallets SET balance = $1 WHERE id = $2`,
            [newBalance, walletId]
        );

        const ledger = await timedQuery<{ id: string }>(client, "walletRepo.debitWallet.ledger",
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
    scope: WalletScope = {},
): Promise<WalletRow | null> {
    const f = walletScopeFilter(scope, 3);
    const result = await timedQuery<WalletRow>(
        client,
        "walletRepo.findWalletByUserAndAsset",
        `SELECT ${WALLET_COLUMNS}
         FROM wallets
         WHERE user_id = $1 AND asset_id = $2 AND ${f.sql}
         LIMIT 1`,
        [userId, assetId, ...f.params],
    );

    return result.rows[0] ?? null;
}

/** Every wallet the user holds in `scope`. */
export async function listScopeWalletIds(client: PoolClient, userId: string, scope: WalletScope): Promise<string[]> {
    const f = walletScopeFilter(scope, 2);
    const { rows } = await timedQuery<{ id: string }>(client, "walletRepo.listScopeWalletIds",
        `SELECT id FROM wallets WHERE user_id = $1 AND ${f.sql}`,
        [userId, ...f.params],
    );
    return rows.map((r) => r.id);
}

export async function lockWalletsForUpdate(
    client: PoolClient,
    walletIds: string[]
): Promise<Map<string, WalletRow>> {
    const sorted = [...walletIds].sort();
    const result = await timedQuery<WalletRow>(client, "walletRepo.lockWalletsForUpdate",
        `
        SELECT ${WALLET_COLUMNS}
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
    await timedQuery(client, "walletRepo.reserveFunds",
        `UPDATE wallets SET reserved = reserved + $1 WHERE id = $2`,
        [amount, walletId]
    );
}

export async function releaseReserved(
    client: PoolClient,
    walletId: string,
    amount: string
): Promise<void> {
    await timedQuery(client, "walletRepo.releaseReserved",
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
    const newBalance = await timedQuery<{ balance: string }>(client, "walletRepo.creditWalletTx.update",
        `
        UPDATE wallets SET balance = balance + $1
        WHERE id = $2
        RETURNING balance
        `,
        [amount, walletId]
    );

    const balanceAfter = newBalance.rows[0].balance;

    await timedQuery(client, "walletRepo.creditWalletTx.ledger",
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
    const result = await timedQuery<{ balance: string }>(
        client,
        "walletRepo.debitAvailableTx.update",
        `UPDATE wallets
         SET balance = balance - $1
         WHERE id = $2
           AND (balance - reserved) >= $1
         RETURNING balance`,
        [amount, walletId]
    );

    if (result.rowCount === 0) {
        throw new Error("insufficient_balance");
    }

    const balanceAfter = result.rows[0].balance;

    await timedQuery(client, "walletRepo.debitAvailableTx.ledger",
        `INSERT INTO ledger_entries (wallet_id, entry_type, amount, balance_after, reference_id, reference_type, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
        [walletId, entryType, `-${amount}`, balanceAfter, refId ?? null, refType ?? null, JSON.stringify(metadata)]
    );
}

/**
 * Debit a wallet without checking available balance.
 * Used for paper-trading short sells where the base balance may go negative.
 */
export async function debitUnconstrainedTx(
    client: PoolClient,
    walletId: string,
    amount: string,
    entryType: string,
    refId?: string,
    refType?: string,
    metadata: any = {}
): Promise<void> {
    const result = await timedQuery<{ balance: string }>(
        client,
        "walletRepo.debitUnconstrainedTx.update",
        `UPDATE wallets
         SET balance = balance - $1
         WHERE id = $2
         RETURNING balance`,
        [amount, walletId]
    );

    if (result.rowCount === 0) {
        throw new Error("wallet_not_found");
    }

    const balanceAfter = result.rows[0].balance;

    await timedQuery(client, "walletRepo.debitUnconstrainedTx.ledger",
        `INSERT INTO ledger_entries (wallet_id, entry_type, amount, balance_after, reference_id, reference_type, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
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
    const newBalance = await timedQuery<{ balance: string }>(client, "walletRepo.consumeReservedAndDebitTx.update",
        `
        UPDATE wallets SET reserved = reserved - $1, balance = balance - $1
        WHERE id = $2
        RETURNING balance
        `,
        [amount, walletId]
    );

    const balanceAfter = newBalance.rows[0].balance;

    await timedQuery(client, "walletRepo.consumeReservedAndDebitTx.ledger",
        `
        INSERT INTO ledger_entries (wallet_id, entry_type, amount, balance_after, reference_id, reference_type, metadata)
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
        `,
        [walletId, entryType, `-${amount}`, balanceAfter, refId ?? null, refType ?? null, JSON.stringify(metadata)]
    );
}




/**
 * `wallet.updated` events for wallets the caller's transaction changed, to
 * publish after COMMIT (txWithEvents). Reads the in-transaction rows — the
 * caller holds them FOR UPDATE, so this is exactly the state that commits.
 *
 * Trading mutates wallets through the *Tx helpers above, which publish
 * nothing; without this the client's AVAILABLE never saw a fill, a limit
 * hold, or a cancel release until a reload.
 */
export async function walletUpdatedEventsTx(
    client: PoolClient,
    walletIds: Iterable<string>,
    entryType: string,
): Promise<AppEvent[]> {
    const ids = [...new Set(walletIds)];
    if (ids.length === 0) return [];
    const { rows } = await timedQuery<WalletRow>(client, "walletRepo.walletUpdatedEventsTx",
        `SELECT id, user_id, asset_id, balance, reserved, created_at, updated_at
         FROM wallets WHERE id = ANY($1::uuid[])`,
        [ids],
    );
    return rows.map((w) => createEvent("wallet.updated", {
        walletId: w.id,
        assetId: w.asset_id,
        balance: w.balance,
        reserved: w.reserved,
        entryType,
    }, { userId: w.user_id }));
}
