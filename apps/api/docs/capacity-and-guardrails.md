# Capacity Guardrails & Load Shedding

Phase 10 PR4 — Graceful Degradation Layer

## Overview

The capacity guardrails system protects the platform under extreme load by
shedding non-critical work before critical trading paths are affected. It
ensures the system degrades gracefully rather than collapsing under pressure.

No matching engine semantics are changed. No financial invariants are weakened.
All rejections are explicit with structured error responses.

## Architecture

```
Request
  |
  v
[Metrics plugin]  -- increments httpInflightRequests
  |
  v
[Load shedding hook]
  |
  |-- getCurrentLoadState()   reads pool.waitingCount, gauge values
  |-- getRoutePriority()      classifies route as CRITICAL / IMPORTANT / LOW
  |-- evaluateRequestPolicy() applies ordered rules
  |
  |-- ALLOW --> continue to route handler
  |-- REJECT_TEMPORARILY --> 503 + structured error
```

## Thresholds

| Parameter | Env Var | Default | Description |
|---|---|---|---|
| maxDbPoolWaiting | `MAX_DB_POOL_WAITING` | 20 | DB pool waiting queue depth before saturation |
| maxOutboxQueueDepth | `MAX_OUTBOX_QUEUE_DEPTH` | 1000 | Pending outbox events before backlog flag |
| maxLockWaiting | `MAX_LOCK_WAITING` | 10 | Lock-waiting queries before contention flag |
| maxInflightRequests | `MAX_INFLIGHT_REQUESTS` | 500 | Concurrent HTTP requests before overflow |
| loadSheddingEnabled | `LOAD_SHEDDING_ENABLED` | true | Master on/off switch |

## Priority Classes

### CRITICAL (never shed)
- `POST /orders`, `DELETE /orders/:id` — order placement and cancellation
- `GET /pairs/:pairId/book`, `GET /pairs/:pairId/snapshot` — order book reads
- `POST /v1/orders`, `DELETE /v1/orders/:id` — v1 trading endpoints
- `/health`, `/healthz`, `/metrics` — operational endpoints

### IMPORTANT (shed only under DB saturation for writes)
- `GET /wallets`, `GET /wallets/:id` — wallet balances
- `GET /v1/portfolio`, `GET /v1/portfolio/equity`, `GET /v1/portfolio/pnl`
- `GET /v1/transactions`
- All other unclassified routes (default)

### LOW (first to shed)
- `/admin/*`, `/v1/admin/*` — admin operations
- `/v1/proof-pack` — proof pack generation
- `/v1/reconciliation` — manual reconciliation triggers
- `/v1/repair` — repair operations
- `/v1/restore-drill` — disaster recovery drills
- `/v1/incidents`, `/v1/event-stream`, `/v1/outbox`, `/v1/system`
- `/replay`, `/risk`

## Shedding Rules (Ordered by Severity)

1. **DB Pool Saturated** (`pool.waitingCount >= MAX_DB_POOL_WAITING`)
   - CRITICAL: always allowed
   - IMPORTANT GET: allowed (read-only)
   - IMPORTANT writes + LOW: rejected with reason `DB_SATURATED`

2. **Outbox Backlog** (`outboxQueueDepth >= MAX_OUTBOX_QUEUE_DEPTH`)
   - LOW: rejected with reason `OUTBOX_BACKLOG`

3. **Lock Contention** (`lockWaitCount >= MAX_LOCK_WAITING`)
   - LOW: rejected with reason `LOCK_CONTENTION`

4. **Inflight Overflow** (any `isOverloaded` flag + LOW priority)
   - LOW: rejected with reason `INFLIGHT_OVERFLOW`

## Backpressure Mechanisms

Beyond HTTP request shedding, background subsystems also apply backpressure:

- **Outbox worker**: Skips polling batch when `isDbSaturated` to avoid deepening
  pool contention. Resumes automatically on next tick when pressure subsides.

- **Reconciliation job**: Skips scheduled run when `isOverloaded`. The heavy
  3-way reconciliation (wallets + fees + positions) would compete with trading.

- **DB pool**: `pool.waitingCount` is the primary saturation signal. The pool
  itself provides natural backpressure via connection queuing.

## Error Response

All load-shedding rejections return:

```
HTTP 503
{
  "error": {
    "code": "SYSTEM_OVERLOADED",
    "message": "System under high load. Please retry shortly.",
    "details": {
      "reason": "DB_SATURATED" | "OUTBOX_BACKLOG" | "LOCK_CONTENTION" | "INFLIGHT_OVERFLOW"
    }
  }
}
```

Clients should implement exponential backoff retry on 503.

## Metrics

| Metric | Type | Labels | Description |
|---|---|---|---|
| `load_shedding_rejections_total` | Counter | `reason` | Requests rejected by load shedding |
| `load_state_overloaded` | Gauge | — | 1 when system overloaded, 0 otherwise |
| `db_pool_waiting_gauge` | Gauge | — | Current pool waiting count (shedding view) |
| `priority_rejection_total` | Counter | `priority` | Rejections by priority class |

These complement existing metrics: `pg_pool_waiting_count`, `http_inflight_requests`,
`outbox_queue_depth`, `pg_lock_waiting_total`.

## Tuning Guide

### Safe Operating Envelope (from PR1/PR3 baseline)

The load harness (PR1) established baseline SLOs. PR3 optimized hot paths.
These guardrails sit above that envelope:

- **Normal operation**: All flags false, no shedding active.
- **Moderate load**: Occasional `isHighLockContention` — LOW routes may see 503.
- **Heavy load**: `isDbSaturated` — only CRITICAL + IMPORTANT GETs served.
- **Extreme load**: Multiple flags true — only CRITICAL trading paths survive.

### Adjusting Thresholds

- **Reduce `MAX_DB_POOL_WAITING`** to shed earlier (more conservative).
- **Increase `MAX_INFLIGHT_REQUESTS`** if the server has headroom.
- **Set `LOAD_SHEDDING_ENABLED=false`** to disable entirely (e.g., during testing).
- **`DB_POOL_MAX`** (pool size) and thresholds should be tuned together:
  a good rule of thumb is `MAX_DB_POOL_WAITING <= DB_POOL_MAX`.

### Monitoring Alerts

Recommended alert thresholds:
- `load_state_overloaded == 1` for > 30 seconds → investigate
- `rate(load_shedding_rejections_total[1m]) > 10` → shedding active, check load
- `pg_pool_waiting_count > 15` sustained → pool sizing may need increase

## Files

| File | Purpose |
|---|---|
| `src/governance/loadState.ts` | Load state monitor — reads live metrics |
| `src/governance/loadShedding.ts` | Policy engine — evaluates shed/allow |
| `src/governance/priorityClasses.ts` | Route → priority mapping |
| `src/config.ts` | Threshold configuration |
| `src/app.ts` | Fastify onRequest hook integration |
| `src/metrics.ts` | Prometheus metrics definitions |
| `src/errors/AppError.ts` | `system_overloaded` error code |
| `src/http/v1Error.ts` | Human-readable error message |
| `src/outbox/outboxWorker.ts` | Outbox backpressure |
| `src/jobs/definitions/reconciliationJob.ts` | Recon backpressure |
