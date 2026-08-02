import type { PoolClient } from "pg";
import Decimal from "decimal.js";
import { D } from "../../utils/decimal";

/**
 * Sum of risk currently reserved for `userId`, counting only reservations
 * whose (user_id, pair_id) still has a nonzero position -- see migration
 * 087's comment: a reservation isn't explicitly released, "still reserved"
 * is computed live via this EXISTS join. Must run inside the same
 * transaction/advisory-lock scope as the caller's exposure-cap check and
 * subsequent reservation insert (see evaluator.ts) -- otherwise two
 * concurrent evaluations could both read a total that's already stale by
 * the time either commits.
 */
export async function getTotalOpenRiskTx(client: PoolClient, userId: string): Promise<Decimal> {
  const { rows } = await client.query<{ total_open_risk: string }>(
    `SELECT COALESCE(SUM(r.risk_amount_quote), 0) AS total_open_risk
     FROM risk_reservations r
     WHERE r.user_id = $1
       AND EXISTS (
         SELECT 1 FROM positions p
         WHERE p.user_id = r.user_id
           AND p.pair_id = r.pair_id
           AND p.base_qty <> 0
       )`,
    [userId],
  );
  return D(rows[0]!.total_open_risk);
}

export async function insertRiskReservationTx(
  client: PoolClient,
  params: { proposalId: string; userId: string; pairId: string; riskAmountQuote: string },
): Promise<void> {
  await client.query(
    `INSERT INTO risk_reservations (proposal_id, user_id, pair_id, risk_amount_quote)
     VALUES ($1, $2, $3, $4)`,
    [params.proposalId, params.userId, params.pairId, params.riskAmountQuote],
  );
}
