/**
 * loadShedding.ts — Load shedding policy engine.
 *
 * Evaluates whether an incoming request should be allowed, throttled,
 * or rejected based on the current system load state and the request's
 * priority class.
 *
 * Rules (ordered by severity):
 *  1. DB pool saturated → reject non-CRITICAL writes, allow GETs + trading
 *  2. Outbox queue too deep → reject LOW endpoints
 *  3. Lock contention high → reject LOW endpoints, log warning
 *  4. Inflight requests high → reject LOW endpoints first
 *
 * NEVER silently drops requests. All rejections are explicit with a reason.
 */

import { type LoadState } from "./loadState";
import { Priority } from "./priorityClasses";

// ── Types ──

export type ShedReason =
  | "DB_SATURATED"
  | "OUTBOX_BACKLOG"
  | "LOCK_CONTENTION"
  | "INFLIGHT_OVERFLOW";

export const enum PolicyDecision {
  ALLOW = "ALLOW",
  REJECT_TEMPORARILY = "REJECT_TEMPORARILY",
}

export interface PolicyResult {
  decision: PolicyDecision;
  reason?: ShedReason;
}

// ── Policy engine ──

/**
 * Evaluate whether a request should be allowed or rejected.
 *
 * @param method    HTTP method
 * @param priority  Route priority from getRoutePriority()
 * @param state     Current load state snapshot
 */
export function evaluateRequestPolicy(
  method: string,
  priority: Priority,
  state: LoadState,
): PolicyResult {
  // CRITICAL routes are NEVER rejected
  if (priority === Priority.CRITICAL) {
    return { decision: PolicyDecision.ALLOW };
  }

  // Rule 1: DB pool saturated
  if (state.isDbSaturated) {
    // Allow GET requests at IMPORTANT priority (read-only)
    if (method === "GET" && priority === Priority.IMPORTANT) {
      return { decision: PolicyDecision.ALLOW };
    }
    // Reject all non-CRITICAL writes and LOW endpoints
    return { decision: PolicyDecision.REJECT_TEMPORARILY, reason: "DB_SATURATED" };
  }

  // Rule 2: Outbox queue too deep — reject LOW
  if (state.isOutboxBackedUp && priority === Priority.LOW) {
    return { decision: PolicyDecision.REJECT_TEMPORARILY, reason: "OUTBOX_BACKLOG" };
  }

  // Rule 3: Lock contention high — reject LOW
  if (state.isHighLockContention && priority === Priority.LOW) {
    return { decision: PolicyDecision.REJECT_TEMPORARILY, reason: "LOCK_CONTENTION" };
  }

  // Rule 4: Inflight overflow — reject LOW first
  if (state.isOverloaded && priority === Priority.LOW) {
    return { decision: PolicyDecision.REJECT_TEMPORARILY, reason: "INFLIGHT_OVERFLOW" };
  }

  return { decision: PolicyDecision.ALLOW };
}
