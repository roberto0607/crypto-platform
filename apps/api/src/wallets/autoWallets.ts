import { pool } from "../db/pool";
import { logger } from "../observability/logContext";

/**
 * Auto-create one wallet per active asset for a user.
 * Uses ON CONFLICT DO NOTHING so it's safe to call multiple times.
 *
 * @param userId - The user ID to create wallets for
 * @param competitionId - Optional competition ID (NULL = free play)
 */
export async function autoCreateWallets(
    userId: string,
    competitionId?: string | null,
): Promise<void> {
    const compId = competitionId ?? null;

    const result = await pool.query(
        `INSERT INTO wallets (id, user_id, asset_id, competition_id, balance, reserved)
         SELECT gen_random_uuid(), $1, a.id, $2, '0.00000000', '0.00000000'
         FROM assets a
         ON CONFLICT DO NOTHING`,
        [userId, compId],
    );

    logger.info(
        { userId, competitionId: compId, walletsCreated: result.rowCount },
        "auto_wallets_created",
    );
}
