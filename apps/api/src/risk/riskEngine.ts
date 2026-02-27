import type { PoolClient } from "pg";
import { D, ZERO } from "../utils/decimal";
import { resolveEffectiveLimits } from "./riskLimitRepo";
import { getOpenBreakers } from "./breakerRepo";
import {
  priceDislocationKey,
  rateAbuseKey,
  RECONCILIATION_KEY,
} from "./breakerService";
import {
  riskChecksTotal,
  riskRejectionsTotal,
  breakerBlocksTotal,
} from "../metrics";
import type { RiskCheckInput, RiskDecision } from "./riskTypes";
import { RISK_CODES } from "./riskTypes";

function reject(
  code: string,
  reason: string,
  details?: Record<string, unknown>,
): RiskDecision {
  riskRejectionsTotal.inc({ code });
  return { ok: false, code, reason, details };
}

/**
 * Runs all pre-trade risk checks in order:
 *   1. Qty sanity
 *   2. Circuit breakers (pair + user + global)
 *   3. Max order notional
 *   4. Price deviation (LIMIT only)
 *   5. Max open orders per pair
 *   6. Max position exposure
 *
 * Returns first failing check or { ok: true, code: "PASS" }.
 * Deterministic for same inputs + same DB state.
 */
export async function evaluateOrderRisk(
  client: PoolClient,
  input: RiskCheckInput,
): Promise<RiskDecision> {
  riskChecksTotal.inc();

  const qty = D(input.qty);

  // ── 1. Qty sanity ──
  if (qty.lte(ZERO) || !qty.isFinite() || qty.dp() > 8) {
    return reject(RISK_CODES.INVALID_QTY, `Invalid qty: ${input.qty}`, {
      qty: input.qty,
    });
  }

  // ── 2. Circuit breakers ──
  const breakerKeys = [
    priceDislocationKey(input.pairId),
    rateAbuseKey(input.userId),
    RECONCILIATION_KEY,
  ];

  const openBreakers = await getOpenBreakers(client, breakerKeys);
  if (openBreakers.length > 0) {
    const b = openBreakers[0];
    breakerBlocksTotal.inc({ breaker: b.breaker_key });
    return reject(RISK_CODES.BREAKER_OPEN, b.reason ?? "Circuit breaker open", {
      breaker_key: b.breaker_key,
      closes_at: b.closes_at,
    });
  }

  // ── 3. Resolve effective limits ──
  const limits = await resolveEffectiveLimits(client, input.userId, input.pairId);

  // ── 4. Max order notional ──
  const price =
    input.type === "LIMIT" && input.limitPrice
      ? D(input.limitPrice)
      : D(input.snapshot.last);
  const notional = price.mul(qty);
  const maxNotional = D(limits.max_order_notional_quote);

  if (notional.gt(maxNotional)) {
    return reject(
      RISK_CODES.MAX_NOTIONAL_EXCEEDED,
      `Order notional ${notional.toFixed(8)} exceeds limit ${maxNotional.toFixed(8)}`,
      { notional: notional.toFixed(8), limit: maxNotional.toFixed(8) },
    );
  }

  // ── 5. Price deviation (LIMIT only) ──
  if (input.type === "LIMIT" && input.limitPrice) {
    const last = D(input.snapshot.last);
    if (last.gt(ZERO)) {
      const limitP = D(input.limitPrice);
      const deviationBps = limitP
        .minus(last)
        .abs()
        .div(last)
        .mul(10_000);

      if (deviationBps.gt(limits.max_price_deviation_bps)) {
        return reject(
          RISK_CODES.PRICE_DEVIATION_EXCEEDED,
          `Price deviation ${deviationBps.toFixed(0)} bps exceeds limit ${limits.max_price_deviation_bps} bps`,
          {
            deviation_bps: deviationBps.toFixed(0),
            limit_bps: limits.max_price_deviation_bps,
            limit_price: input.limitPrice,
            snapshot_last: input.snapshot.last,
          },
        );
      }
    }
  }

  // ── 6. Max open orders per pair ──
  const { rows: countRows } = await client.query<{ cnt: string }>(
    `SELECT COUNT(*)::text AS cnt
       FROM orders
      WHERE user_id = $1
        AND pair_id = $2
        AND status IN ('OPEN', 'PARTIALLY_FILLED')`,
    [input.userId, input.pairId],
  );
  const openCount = parseInt(countRows[0].cnt, 10);

  if (openCount >= limits.max_open_orders_per_pair) {
    return reject(
      RISK_CODES.MAX_OPEN_ORDERS_EXCEEDED,
      `Open orders ${openCount} >= limit ${limits.max_open_orders_per_pair}`,
      { open_count: openCount, limit: limits.max_open_orders_per_pair },
    );
  }

  // ── 7. Max position exposure ──
  const { rows: posRows } = await client.query<{ base_qty: string }>(
    `SELECT base_qty FROM positions
      WHERE user_id = $1 AND pair_id = $2`,
    [input.userId, input.pairId],
  );
  const currentQty = posRows.length > 0 ? D(posRows[0].base_qty) : ZERO;
  const delta = input.side === "BUY" ? qty : qty.neg();
  const projectedQty = currentQty.plus(delta);
  const maxPosition = D(limits.max_position_base_qty);

  if (projectedQty.abs().gt(maxPosition)) {
    return reject(
      RISK_CODES.MAX_POSITION_EXCEEDED,
      `Projected position ${projectedQty.toFixed(8)} exceeds limit ±${maxPosition.toFixed(8)}`,
      {
        current_qty: currentQty.toFixed(8),
        projected_qty: projectedQty.toFixed(8),
        limit: maxPosition.toFixed(8),
      },
    );
  }

  // ── All checks passed ──
  return { ok: true, code: RISK_CODES.PASS, reason: "All checks passed" };
}
