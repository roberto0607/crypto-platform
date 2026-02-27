import { pool } from "../db/pool";

export type LedgerEntryRow = {
    id: string;
    wallet_id: string;
    entry_type: string;
    amount: string;
    balance_after: string;
    reference_id: string | null;
    reference_type: string | null;
    metadata: Record<string, unknown>;
    created_at: string;
};

export async function listLedgerEntries(walletId: string): Promise<LedgerEntryRow[]> {
    const result = await pool.query<LedgerEntryRow>(
        `
        SELECT id, wallet_id, entry_type, amount, balance_after,
               reference_id, reference_type, metadata, created_at
        FROM ledger_entries
        WHERE wallet_id = $1
        ORDER BY created_at DESC
        `,
        [walletId]
    );

    return result.rows;
}

/**
 * Paginated ledger entries for /v1 — keyset on (created_at DESC, id DESC).
 * Fetches limit + 1 rows; caller uses slicePage() to detect next page.
 */
export async function listLedgerEntriesPaginated(
    walletId: string,
    limit: number,
    cursor: { ca: string; id: string } | null,
): Promise<LedgerEntryRow[]> {
    let query = `
        SELECT id, wallet_id, entry_type, amount, balance_after,
               reference_id, reference_type, metadata, created_at
        FROM ledger_entries
        WHERE wallet_id = $1`;
    const params: (string | number)[] = [walletId];

    if (cursor) {
        params.push(cursor.ca);
        const caIdx = params.length;
        params.push(cursor.id);
        const idIdx = params.length;
        query += ` AND (created_at, id) < ($${caIdx}, $${idIdx})`;
    }

    params.push(limit + 1);
    query += ` ORDER BY created_at DESC, id DESC LIMIT $${params.length}`;

    const result = await pool.query<LedgerEntryRow>(query, params);
    return result.rows;
}