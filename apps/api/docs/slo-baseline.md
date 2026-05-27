# Baseline SLOs — Phase 10 PR1

This document defines initial Service Level Objectives for the crypto paper-trading API.
These are **measurement targets**, not production commitments. Numbers will be updated
after real baseline runs are recorded in the table below.

---

## Definitions

### Latency Percentiles

| Metric | Definition |
|---|---|
| **p50** | Median — 50% of requests complete within this time |
| **p95** | 95th percentile — 95% of requests complete within this time |
| **p99** | 99th percentile — tail latency; outlier-sensitive |

All latency values are measured end-to-end at the HTTP response level
(client sends request → receives first byte of response body).

Source: k6 `http_req_duration` + custom Trend metrics per scenario.
Also available from Prometheus: `http_request_duration_seconds` histogram.

Note: Prometheus metric is in **seconds** (`http_request_duration_seconds`),
not milliseconds. Multiply by 1000 for ms equivalents in PromQL.

### Throughput

Requests per second (RPS) sustained over the test duration.
Measured as `http_reqs / duration` from k6 summary output.

For orders specifically: **orders per second (OPS)** = successful POST /orders 201 responses / duration.

### Error Rate

Fraction of HTTP responses with status 4xx or 5xx, or network-level failures.

`http_req_failed` in k6. In Prometheus:
```promql
rate(http_requests_total{status=~"[45].."}[1m]) / rate(http_requests_total[1m])
```

### Outbox Lag

Time from `created_at` (event inserted into outbox table) to `processed_at`
(event successfully handled by outbox worker).

Measured by:
- `outbox_queue_depth` gauge — depth at a point in time
- `outbox_processing_duration_ms` histogram — per-event processing time
- Under load: watch `outbox_queue_depth` grow and stabilize

---

## Initial Baseline Targets

These targets are set conservatively for a single-node local environment
running on Docker Postgres. Adjust after first real baseline run.

| Endpoint class | Metric | Target |
|---|---|---|
| POST /orders | p95 latency | < 250 ms |
| POST /orders | p99 latency | < 500 ms |
| GET /pairs/:id/book | p95 latency | < 150 ms |
| GET /positions, /pnl/summary | p95 latency | < 150 ms |
| GET /wallets, /pairs | p95 latency | < 100 ms |
| GET /auth/me | p95 latency | < 100 ms |
| Any endpoint | Error rate | < 0.5% |
| Outbox lag | p95 processing duration | < 5 s |
| Outbox queue depth | Under 25 RPS write load | < 100 pending |

---

## Prometheus Metric Inventory

| Metric name | Type | Labels | Description |
|---|---|---|---|
| `http_request_duration_seconds` | Histogram | method, route, status | Request duration (seconds) |
| `http_requests_total` | Counter | method, route, status | Total request count |
| `pg_pool_total_count` | Gauge | — | Total PG pool clients |
| `pg_pool_idle_count` | Gauge | — | Idle PG pool clients |
| `pg_pool_waiting_count` | Gauge | — | Clients waiting for connection |
| `outbox_queue_depth` | Gauge | — | Pending outbox events |
| `outbox_processing_duration_ms` | Histogram | event_type | Per-event outbox processing time |
| `outbox_processed_total` | Counter | event_type | Successfully processed outbox events |
| `outbox_failures_total` | Counter | event_type | Failed outbox events |
| `reconciliation_run_latency_ms` | Histogram | — | Reconciliation run duration |
| `order_placement_latency_ms` | Histogram | — | Order placement end-to-end latency |
| `pair_queue_depth` | Gauge | pairId | Per-pair order queue depth |
| `pair_queue_exec_ms` | Histogram | pairId | Time inside queue worker |
| `pair_queue_wait_ms` | Histogram | pairId | Queue wait time before execution |

---

## Baseline Run Results

Record each baseline run here after completing the scenario suite.

| Date | Git SHA | Scenario | VUs | Duration | p50 | p95 | p99 | RPS | Error % | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| 2026-03-03 | 35aa84a | auth_smoke | 5 | 30s | — | 43ms | — | — | 0.00% | login+me; all 650/650 checks pass |
| 2026-03-03 | 35aa84a | read_heavy | 20 | 60s | — | 35ms | — | 175 | 0.00% | 5 GET endpoints/iter; read_latency_ms p95=35ms |
| 2026-03-03 | 35aa84a | trade_burst | 10 | 60s | — | 64ms | — | 9 OPS | 0.00% | MARKET+LIMIT+cancel; order_placement_ms p95=72ms; cancel p95=6ms |
| 2026-03-03 | 35aa84a | mixed_realistic | 15 | 90s | — | 41ms | — | 47 | 0.22% | 70% reads/30% writes; read p95=6ms; write p95=51ms |
| 2026-03-03 | 35aa84a | outbox_pressure | 5+1 | 60s | — | 42ms | — | 22 | 0.00% | outbox_order_ms p95=39ms; queue_depth peak=50 |

### How to capture a run

```bash
# From apps/api/ — capture git SHA
git rev-parse --short HEAD

# Run a scenario, export JSON
k6 run --out json=load/results/reads-YYYYMMDD.json load/k6/scenario_read_heavy.js

# Extract p95 from JSON output (jq)
jq '.metrics.http_req_duration.values["p(95)"]' load/results/reads-YYYYMMDD.json
```

---

## Baseline Run — 2026-05-26 (in-memory vs Redis, vs March 3)

Git SHA `1eb5fb3`. Both passes: 50 seeded users, single pair **BTC/USD**,
`DISABLE_RATE_LIMIT=true DISABLE_JOB_RUNNER=true` (market-maker bot off → thin
book), local Docker Postgres. In-memory pass: `REDIS_URL` unset. Redis pass:
`REDIS_URL=redis://localhost:6379` (Redis Streams, confirmed via live
`cp:queue:*` keys). March 3 rows recorded p95 only; today's passes capture full
p50/p95/p99.

### Headline comparison — http_req_duration p95 / error rate

| Scenario        | March 3 (in-mem) | Today (in-mem) | Today (Redis)          |
|-----------------|------------------|----------------|------------------------|
| auth_smoke      | p95 43ms, 0%     | p95 49ms, 0%   | p95 48ms, 0% ✓         |
| read_heavy      | p95 35ms, 0%     | p95 8.6ms, 0%  | p95 10ms, 0% ✓         |
| trade_burst     | p95 64ms, 0%     | p95 185ms, 0%  | **84.5% FAIL** (503s)  |
| mixed_realistic | p95 41ms, 0.22%  | p95 48ms, 0%   | **28.9% FAIL** (503s)  |
| outbox_pressure | p95 42ms, 0%     | p95 39ms, 0%   | **94.8% FAIL** (503s)  |

(auth p95 is dominated by the 50 sequential argon2 logins in `setup()`, not the
measured `/auth/me` calls — consistent across all three columns.)

### Full distribution — today's two passes

| Scenario        | Pass   | p50    | p95     | p99     | RPS   | Err%   | Domain metric (p95)             |
|-----------------|--------|--------|---------|---------|-------|--------|---------------------------------|
| auth_smoke      | in-mem | 3.9ms  | 48.6ms  | 52.7ms  | 10.7  | 0.00%  | —                               |
| auth_smoke      | redis  | 4.3ms  | 47.7ms  | 51.9ms  | 10.7  | 0.00%  | —                               |
| read_heavy      | in-mem | 3.5ms  | 8.6ms   | 12.3ms  | 185.7 | 0.00%  | read_latency 8.4ms              |
| read_heavy      | redis  | 5.2ms  | 10.0ms  | 12.9ms  | 182.9 | 0.00%  | read_latency 9.9ms              |
| trade_burst     | in-mem | 49.5ms | 185.1ms | 226.8ms | 24.7  | 0.00%  | order_placement 201ms; cancel 6.7ms |
| trade_burst     | redis  | 4.1ms† | 83.3ms† | 199.5ms†| 20.3  | 84.51% | order_placement 93ms†           |
| mixed_realistic | in-mem | 1.9ms  | 47.9ms  | 70.6ms  | 47.1  | 0.00%  | write 64ms / read 3.3ms         |
| mixed_realistic | redis  | 5.3ms† | 13.8ms† | 43.9ms† | 48.3  | 28.85% | write 13.5ms / read 12.6ms      |
| outbox_pressure | in-mem | 29.5ms | 39.5ms  | 50.2ms  | 22.1  | 0.00%  | outbox_order 34.6ms; qdepth max 0 |
| outbox_pressure | redis  | 5.5ms† | 9.8ms†  | 47.7ms† | 24.6  | 94.78% | outbox_order 8.5ms; qdepth max 0 |

† Redis write-scenario latency blends ~85/29/95% **fast 503 rejections** with the
minority of successful placements — so these latency cells are NOT comparable to
the in-mem column. The takeaway for those rows is the **error rate**, not the ms.

### Findings / anomalies

1. **🔴 Redis order queue bricks per-pair after `MAX_QUEUE_DEPTH` (100) lifetime
   orders — likely a production scaling bug.** Every write-heavy Redis scenario
   failed on `pair_queue_overloaded` (HTTP 503), *not* on latency. Root cause:
   the depth guard reads `XLEN(stream)` (`redisQueue.ts:202`), but the consumer
   `XACK`s **without `XDEL`/`XTRIM`** (`redisQueue.ts:432`), so `XLEN` counts
   every entry ever added and never shrinks. After 100 orders are `XADD`ed to a
   pair's stream (between restarts), `xlen` stays ≥100 and all further orders
   503 — even though the consumer is fully drained (verified `pending=0, lag=0`,
   `xlen=100`). Only a server restart clears it (startup flush,
   `redisQueue.ts:109-125`). The in-memory path **cannot** exhibit this: it
   checks `pq.jobs.length`, which shrinks as jobs drain (hence 0% errors). This
   is invisible at today's tiny load + frequent deploys, but fatal under
   sustained real load. **Direct answer to "can it handle real users?" — not
   yet.** Tracked in `docs/followups.md`.

2. **🟡 trade_burst order placement ~2.8× slower than March (in-mem):** 201ms vs
   72ms p95. Plausibly the per-order `getActiveMatchIdForUser` DB lookup added at
   the HTTP edge by PR #26 (now runs on every order) plus heavier schema/candle
   state. Still under the 250ms SLO, but the margin shrank from ~3.5× to ~1.2×.
   Worth confirming that lookup is indexed.

3. **🟢 Reads are healthy on both backends:** read_heavy p95 8.6ms (in-mem) /
   10ms (Redis) at ~185 RPS, 0% errors — well under the 150ms SLO and faster than
   March's 35ms. Redis adds ~1.5ms read overhead (expected, not concerning).

4. **Redis write latency on *successful* ops is excellent** — the pipeline is
   fast; the only problem is the XLEN backpressure bug in finding 1.

5. **Single-pair artifact:** all load hit one pair (BTC/USD = one consumer),
   which both concentrates the queue bug and leaves cross-pair scaling (PR #28)
   unexercised. Phase 2B's multi-pair scenario is needed to separate "queue bug"
   from "single-consumer throughput ceiling."

---

## Post-fix — 2026-05-27 (candles query pinned to timeframe='1m', PR #31)

The trade_burst regression (per-order candles seq scan) is fixed — PR #31 (`8e3bb73`),
merged (`e7cda6a`) and deployed to prod (Railway deploy `4ee541c9`, SUCCESS).

### trade_burst — new floor (local, Redis backend, ×2 runs)

| order_placement_ms p95 | http_req p95 | err | source |
|---|---|---|---|
| 72ms | 64ms | 0% | March 3 (`35aa84a`, in-mem) |
| 253–254ms | 240ms | 0% | pre-fix (2026-05-27, `fe8433a`, in-mem) |
| **60.1 / 60.2ms** | **54 / 53ms** | **0%** | **post-fix (`e7cda6a`, Redis)** |

**60ms p95 is the new floor** (below March despite the Redis round-trip). Per-order
exec dropped ~25ms → ~8ms. 0% errors — the XLEN fix holds on the Redis write path.

### Candle query — before/after (EXPLAIN ANALYZE)

| | local (211k candles) | prod (805k candles) |
|---|---|---|
| old, no timeframe — Parallel Seq Scan | 18.9ms | 133.4ms |
| fixed, `timeframe='1m'` — Index Scan | 0.30ms | **0.108ms** |

### ⚠️ Caveat: prod per-order exec ≈ 190ms (NOT the candle query)
Manual demo MARKET orders on prod returned 201/FILLED in sub-second round-trip, but
`pair_queue_exec_ms` ≈ 190ms/order. The candle query is now 0.1ms, so this residual
is the rest of the prod order pipeline (matching/ledger/snapshot + prod DB latency
over larger tables) — pre-existing, separate from this fix. Tracked in followups.md.

---

## Alert Thresholds (Future)

Once Prometheus + Alertmanager are configured, suggested alert rules:

```yaml
# p95 order latency > 500ms for 2 minutes
- alert: OrderLatencyHigh
  expr: histogram_quantile(0.95, rate(http_request_duration_seconds_bucket{route="/orders",method="POST"}[2m])) * 1000 > 500
  for: 2m

# Error rate > 1% for 1 minute
- alert: HighErrorRate
  expr: rate(http_requests_total{status=~"[45].."}[1m]) / rate(http_requests_total[1m]) > 0.01
  for: 1m

# Outbox queue growing unchecked
- alert: OutboxBacklog
  expr: outbox_queue_depth > 500
  for: 5m
```
