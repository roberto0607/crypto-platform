import type { PoolClient } from "pg";
import { tripBreaker, getOpenBreakers } from "./breakerRepo";
import { recordAttempt, isAboveThreshold } from "./rateLimiterWindow";
import { auditLog } from "../audit/log";
import { breakerTripsTotal } from "../metrics";
import { logger } from "../observability/logContext";

// ── Configurable thresholds ──

const PRICE_DISLOCATION_BPS = parseInt(
  process.env.BREAKER_PRICE_DISLOCATION_BPS ?? "",
  10,
) || 1000; // default 10%

const PRICE_DISLOCATION_COOLDOWN_S = parseInt(
  process.env.BREAKER_PRICE_DISLOCATION_COOLDOWN_S ?? "",
  10,
) || 300; // 5 min

const RECONCILIATION_COOLDOWN_S = parseInt(
  process.env.BREAKER_RECONCILIATION_COOLDOWN_S ?? "",
  10,
) || 600; // 10 min

const RATE_ABUSE_COOLDOWN_S = parseInt(
  process.env.BREAKER_RATE_ABUSE_COOLDOWN_S ?? "",
  10,
) || 120; // 2 min

// ── Breaker key helpers ──

export function priceDislocationKey(pairId: string): string {
  return `PRICE_DISLOCATION:PAIR:${pairId}`;
}

export function rateAbuseKey(userId: string): string {
  return `RATE_ABUSE:USER:${userId}`;
}

export const RECONCILIATION_KEY = "RECONCILIATION_CRITICAL";

// ── Price dislocation ──

/**
 * Compare snapshot.last vs DB last_price for a pair.
 * Trip breaker if deviation > threshold.
 * Must be called with a valid PoolClient inside a transaction.
 */
export async function checkPriceDislocation(
  client: PoolClient,
  pairId: string,
  snapshotLast: string,
  dbLastPrice: string,
): Promise<void> {
  const snapshotVal = parseFloat(snapshotLast);
  const dbVal = parseFloat(dbLastPrice);

  // Skip if either price is zero or invalid
  if (!dbVal || !snapshotVal || !isFinite(dbVal) || !isFinite(snapshotVal)) {
    return;
  }

  const deviationBps = Math.abs(snapshotVal - dbVal) / dbVal * 10_000;

  if (deviationBps > PRICE_DISLOCATION_BPS) {
    const key = priceDislocationKey(pairId);
    await tripBreaker(client, {
      breakerKey: key,
      reason: `Price dislocation: snapshot=${snapshotLast} vs db=${dbLastPrice} (${Math.round(deviationBps)} bps)`,
      cooldownSeconds: PRICE_DISLOCATION_COOLDOWN_S,
      metadata: { snapshotLast, dbLastPrice, deviationBps: Math.round(deviationBps) },
    });
    breakerTripsTotal.inc({ breaker: "PRICE_DISLOCATION" });
    logger.warn({ eventType: "breaker.trip", breakerKey: key, deviationBps: Math.round(deviationBps) }, "Price dislocation breaker tripped");
    await auditLog({
      actorUserId: null,
      action: "breaker.trip",
      targetType: "circuit_breaker",
      targetId: key,
      metadata: { snapshotLast, dbLastPrice, deviationBps: Math.round(deviationBps) },
    });
  }
}

// ── Reconciliation breaker ──

/**
 * Trip global breaker if reconciliation status is CRITICAL.
 * Called after reconciliation runs.
 */
export async function checkReconciliationBreaker(
  client: PoolClient,
  reconciliationStatus: string,
): Promise<void> {
  if (reconciliationStatus !== "CRITICAL") return;

  await tripBreaker(client, {
    breakerKey: RECONCILIATION_KEY,
    reason: "Reconciliation reported CRITICAL mismatches — trading halted",
    cooldownSeconds: RECONCILIATION_COOLDOWN_S,
    metadata: { status: reconciliationStatus },
  });
  breakerTripsTotal.inc({ breaker: "RECONCILIATION_CRITICAL" });
  logger.warn({ eventType: "breaker.trip", breakerKey: RECONCILIATION_KEY, status: reconciliationStatus }, "Reconciliation breaker tripped");
  await auditLog({
    actorUserId: null,
    action: "breaker.trip",
    targetType: "circuit_breaker",
    targetId: RECONCILIATION_KEY,
    metadata: { reconciliationStatus },
  });
}

// ── Rate abuse ──

/**
 * Record an order attempt and trip breaker if threshold exceeded.
 */
export async function recordOrderAttempt(
  client: PoolClient,
  userId: string,
): Promise<void> {
  await recordAttempt(userId);

  if (await isAboveThreshold(userId)) {
    const key = rateAbuseKey(userId);

    // Only trip if not already open
    const open = await getOpenBreakers(client, [key]);
    if (open.length === 0) {
      await tripBreaker(client, {
        breakerKey: key,
        reason: "Rate abuse: too many order attempts in rolling window",
        cooldownSeconds: RATE_ABUSE_COOLDOWN_S,
        metadata: { userId },
      });
      breakerTripsTotal.inc({ breaker: "RATE_ABUSE" });
      logger.warn({ eventType: "breaker.trip", breakerKey: key, userId }, "Rate abuse breaker tripped");
      await auditLog({
        actorUserId: userId,
        action: "breaker.trip",
        targetType: "circuit_breaker",
        targetId: key,
        metadata: { userId },
      });
    }
  }
}

/**
 * Check if the rate abuse breaker is open for a user.
 */
export async function checkRateAbuse(
  client: PoolClient,
  userId: string,
): Promise<boolean> {
  const key = rateAbuseKey(userId);
  const open = await getOpenBreakers(client, [key]);
  return open.length > 0;
}
