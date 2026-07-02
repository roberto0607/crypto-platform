import type { PoolClient } from "pg";
import { pool } from "../db/pool";
import { logger } from "../observability/logContext";
import { creditWalletTx } from "./walletRepo";
import { STARTING_CAPITAL_USD, FREE_PLAY_CREDIT_ENTRY_TYPE } from "./startingCapital";

/**
 * Auto-create one wallet per active asset for a user, and — for the free-play
 * scope (competition_id NULL) — fund the USD wallet with STARTING_CAPITAL_USD.
 *
 * Runs in a single transaction so wallet creation and funding land atomically.
 * Idempotent on both counts: wallet inserts use ON CONFLICT DO NOTHING, and the
 * free-play grant is guarded by a check-then-insert plus a partial unique index
 * (migration 070), so calling this twice never double-credits ($200K).
 *
 * Scope guarantee: funding touches ONLY the free-play USD wallet. Competition-
 * scoped wallets (competitionId set) get created here but are NEVER funded —
 * ranked capital stays governed solely by joinCompetition → COMPETITION_CREDIT.
 *
 * @param userId - The user ID to create wallets for
 * @param competitionId - Optional competition ID (NULL = free play)
 * @param existingClient - Optional caller transaction to join (e.g. registration).
 *                         When omitted, this manages its own BEGIN/COMMIT.
 */
export async function autoCreateWallets(
    userId: string,
    competitionId?: string | null,
    existingClient?: PoolClient,
): Promise<void> {
    const compId = competitionId ?? null;
    const ownTx = !existingClient;
    const client = existingClient ?? (await pool.connect());

    try {
        if (ownTx) await client.query("BEGIN");

        const result = await client.query(
            `INSERT INTO wallets (id, user_id, asset_id, competition_id, balance, reserved)
             SELECT gen_random_uuid(), $1, a.id, $2, '0.00000000', '0.00000000'
             FROM assets a
             ON CONFLICT DO NOTHING`,
            [userId, compId],
        );

        let funded = false;
        if (compId === null) {
            funded = await fundFreePlayUsdWallet(client, userId);
        }

        if (ownTx) await client.query("COMMIT");

        logger.info(
            { userId, competitionId: compId, walletsCreated: result.rowCount, funded },
            "auto_wallets_created",
        );
    } catch (err) {
        if (ownTx) await client.query("ROLLBACK").catch(() => {});
        throw err;
    } finally {
        if (ownTx) client.release();
    }
}

/**
 * Credit the free-play USD wallet with the starting capital, exactly once.
 * Returns true if a grant was written, false if it was already funded (or the
 * user has no free-play USD wallet, e.g. USD asset inactive).
 */
async function fundFreePlayUsdWallet(
    client: PoolClient,
    userId: string,
): Promise<boolean> {
    const usdWallet = await client.query<{ id: string }>(
        `SELECT w.id FROM wallets w
         JOIN assets a ON a.id = w.asset_id
         WHERE w.user_id = $1 AND w.competition_id IS NULL AND a.symbol = 'USD'
         LIMIT 1`,
        [userId],
    );
    if (usdWallet.rows.length === 0) return false;

    const usdWalletId = usdWallet.rows[0].id;

    // Idempotency: skip if this wallet already received the free-play grant.
    const already = await client.query(
        `SELECT 1 FROM ledger_entries
         WHERE wallet_id = $1 AND entry_type = $2
         LIMIT 1`,
        [usdWalletId, FREE_PLAY_CREDIT_ENTRY_TYPE],
    );
    if ((already.rowCount ?? 0) > 0) return false;

    await creditWalletTx(
        client,
        usdWalletId,
        STARTING_CAPITAL_USD,
        FREE_PLAY_CREDIT_ENTRY_TYPE,
        userId,
        "USER",
        { reason: "free_play_starting_capital" },
    );
    return true;
}
