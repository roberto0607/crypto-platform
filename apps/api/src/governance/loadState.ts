/**
 * loadState.ts — Global load state monitor.
 *
 * Reads live metrics from the PG pool, lock sampler gauges, outbox depth,
 * and HTTP inflight counter to produce a point-in-time LoadState snapshot.
 *
 * No background polling — computed on-demand per request.
 * Thresholds are configured via config.ts.
 */

import { pool } from "../db/pool";
import { config } from "../config";
import {
  httpInflightRequests,
  outboxQueueDepth,
  pgLockWaitingTotal,
} from "../metrics";

// ── Types ──

export interface LoadState {
  /** Raw metrics */
  dbPoolWaitingCount: number;
  outboxQueueDepth: number;
  lockWaitCount: number;
  inflightRequests: number;

  /** Derived flags */
  isDbSaturated: boolean;
  isOutboxBackedUp: boolean;
  isHighLockContention: boolean;
  isOverloaded: boolean;
}

// ── Helpers to read gauge values ──

function getGaugeValue(gauge: { get: () => Promise<{ values: { value: number }[] }> }): number {
  // prom-client Gauge stores latest value synchronously in hashMap;
  // we access it via the internal `hashMap` for zero-async overhead.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = gauge as any;
  if (typeof g.hashMap === "object") {
    const keys = Object.keys(g.hashMap);
    if (keys.length > 0) return g.hashMap[keys[0]].value ?? 0;
  }
  return 0;
}

// ── Main export ──

export function getCurrentLoadState(): LoadState {
  const dbPoolWaitingCount = pool.waitingCount;
  const outbox = getGaugeValue(outboxQueueDepth);
  const lockWait = getGaugeValue(pgLockWaitingTotal);
  const inflight = getGaugeValue(httpInflightRequests);

  const isDbSaturated = dbPoolWaitingCount >= config.maxDbPoolWaiting;
  const isOutboxBackedUp = outbox >= config.maxOutboxQueueDepth;
  const isHighLockContention = lockWait >= config.maxLockWaiting;
  const isInflightHigh = inflight >= config.maxInflightRequests;

  return {
    dbPoolWaitingCount,
    outboxQueueDepth: outbox,
    lockWaitCount: lockWait,
    inflightRequests: inflight,

    isDbSaturated,
    isOutboxBackedUp,
    isHighLockContention,
    isOverloaded: isDbSaturated || isOutboxBackedUp || isHighLockContention || isInflightHigh,
  };
}
