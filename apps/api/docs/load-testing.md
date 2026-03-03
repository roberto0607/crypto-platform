# Load Testing Guide

## Overview

This guide covers how to run the k6 load test suite for the crypto paper-trading API.
All scenarios use pre-seeded deterministic test data for reproducible results.

## Prerequisites

| Tool | Install |
|---|---|
| Docker | https://docs.docker.com/get-docker/ |
| k6 | `brew install k6` (macOS) or https://k6.io/docs/get-started/installation/ |
| pnpm | https://pnpm.io/installation |

## Step 1 — Start Infrastructure

```bash
# From repo root
docker compose up -d

# Verify PostgreSQL is running
docker compose ps
```

## Step 2 — Apply Migrations

```bash
# From apps/api/
pnpm migrate
```

## Step 3 — Seed Load Test Data

```bash
# From apps/api/
LOADTEST_USERS=50 LOADTEST_USD_BALANCE=100000 pnpm seed:loadtest
```

This creates:
- 50 test users (`loadtest_user_0@loadtest.local` … `loadtest_user_49@loadtest.local`)
- BTC + USD assets (idempotent)
- BTC/USD trading pair (idempotent)
- BTC + USD wallets for each user (USD balance reset to $100,000)
- `apps/api/load/k6/seed-manifest.json` (gitignored — contains user credentials)

Re-run any time to reset wallet balances and regenerate the manifest.

## Step 4 — Start API (rate limiting + background jobs disabled)

```bash
# From apps/api/
DISABLE_RATE_LIMIT=true DISABLE_JOB_RUNNER=true pnpm dev
```

Both env vars are required because:
- `DISABLE_RATE_LIMIT=true` — Login: 5 req/min per IP would throttle k6 setup; POST /orders: 60 req/min would throttle burst scenarios
- `DISABLE_JOB_RUNNER=true` — The reconciliation job (300s interval) re-quarantines loadtest users mid-test; disabling it keeps accounts ACTIVE for the full test window. The outbox worker runs independently and is NOT disabled.

## Step 5 — Run Scenarios

```bash
# From apps/api/

# Scenario 1: Auth smoke — login + GET /auth/me (5 VUs, 30s)
pnpm load:auth

# Scenario 2: Read-heavy — 5 GET endpoints per iteration (20 VUs, 60s)
pnpm load:reads

# Scenario 3: Trade burst — MARKET + LIMIT + cancel per iteration (10 VUs, 60s)
pnpm load:writes

# Scenario 4: Mixed realistic — 70% reads / 30% writes (15 VUs, 90s)
pnpm load:mixed

# Scenario 5: Outbox pressure — writers + metrics poller (5+1 VUs, 60s)
pnpm load:outbox
```

To export results for baseline recording:

```bash
mkdir -p load/results
k6 run --out json=load/results/reads-$(date +%Y%m%d-%H%M%S).json \
  load/k6/scenario_read_heavy.js
```

## Interpreting k6 Output

k6 prints a summary table at the end of each run. Key fields:

| Field | What it means |
|---|---|
| `http_req_duration` p(95) | 95th percentile response time |
| `http_req_failed` | Fraction of requests that failed (non-2xx or network error) |
| `http_reqs` | Total requests; divide by duration for RPS |
| `iterations` | Total scenario iterations completed |
| `vus` | Peak VU count |
| Custom `*_latency_ms` | Domain-specific latency trends |

**Example healthy output (reads scenario):**
```
http_req_duration.....: avg=45ms  p(90)=82ms  p(95)=110ms  p(99)=185ms
http_req_failed.......: 0.00%
http_reqs.............: 12480  (208/s)
read_latency_ms.......: avg=44ms  p(95)=108ms
```

## Viewing Prometheus Metrics During Load

```bash
# Live metrics snapshot
curl http://localhost:3001/metrics

# Key metrics to watch during load
curl -s http://localhost:3001/metrics | grep -E \
  'http_request_duration|http_requests_total|outbox_queue_depth|pg_pool_waiting'
```

### PromQL Reference (if running Prometheus + Grafana)

```promql
# p95 HTTP latency per route (note: metric is in seconds, multiply by 1000 for ms)
histogram_quantile(0.95,
  rate(http_request_duration_seconds_bucket[1m])
) * 1000

# Request rate by route
rate(http_requests_total[1m])

# Error rate (non-2xx)
rate(http_requests_total{status=~"[45].."}[1m])
  / rate(http_requests_total[1m])

# Outbox queue depth
outbox_queue_depth

# Outbox processing p95
histogram_quantile(0.95,
  rate(outbox_processing_duration_ms_bucket[1m])
)

# PG pool pressure
pg_pool_waiting_count
```

## Resetting Between Runs

If wallets are depleted (users ran out of USD from market orders):

```bash
LOADTEST_USERS=50 LOADTEST_USD_BALANCE=100000 pnpm seed:loadtest
```

This resets wallet balances in-place (idempotent).
