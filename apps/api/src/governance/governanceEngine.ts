import type { PoolClient } from "pg";
import type { GovernanceCheckInput, GovernanceDecision } from "./governanceTypes";
import { GOVERNANCE_CODES } from "./governanceTypes";
import {
  getAccountLimits,
  getDailyNotional,
  getDailyRealizedLoss,
  getOpenPositionCount,
  getOpenOrderCount,
  hasPositionForPair,
} from "./governanceRepo";
import { D } from "../utils/decimal";
import { governanceRejectionsTotal } from "../metrics";
import { logger } from "../observability/logContext";

function reject(
  code: string,
  message: string,
  details?: Record<string, unknown>,
): GovernanceDecision {
  governanceRejectionsTotal.inc({ code });
  logger.warn({ code, message, details }, "governance_rejected");
  return { ok: false, code, message, details };
}

/**
 * Compute the epoch-ms timestamp for the start of the current UTC day.
 */
function startOfUtcDay(snapshotTs: string): number {
  const d = new Date(snapshotTs);
  const utcStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return utcStart;
}

/**
 * Evaluate account-level governance limits.
 *
 * Runs BEFORE pair-level risk checks (riskEngine.evaluateOrderRisk).
 * If any check fails, the order must NOT be created.
 */
export async function evaluateAccountGovernance(
  client: PoolClient,
  input: GovernanceCheckInput,
): Promise<GovernanceDecision> {
  const limits = await getAccountLimits(client, input.userId);

  // No row → no limits configured → pass
  if (!limits) {
    return { ok: true };
  }

  // ── 1. Account status check ──
  if (limits.account_status === "SUSPENDED") {
    return reject(GOVERNANCE_CODES.ACCOUNT_SUSPENDED, "Account is suspended");
  }
  if (limits.account_status === "LOCKED") {
    return reject(GOVERNANCE_CODES.ACCOUNT_LOCKED, "Account is locked");
  }

  const utcDayStartMs = startOfUtcDay(input.snapshotTs);

  // ── 2. Daily notional cap ──
  if (limits.max_daily_notional_quote !== null) {
    const todayNotional = await getDailyNotional(client, input.userId, utcDayStartMs);
    const projected = D(todayNotional).plus(D(input.estimatedNotional));
    const cap = D(limits.max_daily_notional_quote);

    if (projected.greaterThan(cap)) {
      return reject(GOVERNANCE_CODES.DAILY_NOTIONAL_LIMIT_EXCEEDED,
        "Daily notional trading limit exceeded", {
          todayNotional,
          estimatedNotional: input.estimatedNotional,
          projected: projected.toFixed(8),
          limit: limits.max_daily_notional_quote,
        });
    }
  }

  // ── 3. Daily realized loss cap ──
  if (limits.max_daily_realized_loss_quote !== null) {
    const todayRealizedPnl = await getDailyRealizedLoss(client, input.userId, utcDayStartMs);
    const pnl = D(todayRealizedPnl);
    const lossCap = D(limits.max_daily_realized_loss_quote);

    if (pnl.isNegative() && pnl.abs().greaterThan(lossCap)) {
      return reject(GOVERNANCE_CODES.DAILY_LOSS_LIMIT_EXCEEDED,
        "Daily realized loss limit exceeded", {
          todayRealizedPnl,
          absLoss: pnl.abs().toFixed(8),
          limit: limits.max_daily_realized_loss_quote,
        });
    }
  }

  // ── 4. Max open positions ──
  if (limits.max_open_positions !== null) {
    const openPos = await getOpenPositionCount(client, input.userId);

    if (openPos >= limits.max_open_positions) {
      // Only reject if this order would open a NEW position on a new pair
      const alreadyHasPosition = await hasPositionForPair(client, input.userId, input.pairId);

      if (!alreadyHasPosition) {
        return reject(GOVERNANCE_CODES.MAX_OPEN_POSITIONS_EXCEEDED,
          "Maximum open positions exceeded", {
            openPositions: openPos,
            limit: limits.max_open_positions,
          });
      }
    }
  }

  // ── 5. Max open orders ──
  if (limits.max_open_orders !== null) {
    const openOrders = await getOpenOrderCount(client, input.userId);

    if (openOrders >= limits.max_open_orders) {
      return reject(GOVERNANCE_CODES.MAX_OPEN_ORDERS_EXCEEDED,
        "Maximum open orders exceeded", {
          openOrders,
          limit: limits.max_open_orders,
        });
    }
  }

  return { ok: true };
}
