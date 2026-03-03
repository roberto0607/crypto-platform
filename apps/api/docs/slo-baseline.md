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
