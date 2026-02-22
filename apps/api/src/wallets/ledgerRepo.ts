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