# k6 Load Tests — Phase 10 PR1

## Prerequisites

1. **k6 installed** — https://k6.io/docs/get-started/installation/
   - macOS: `brew install k6`
   - Linux: see official docs
2. **PostgreSQL running**: `docker compose up -d` (repo root)
3. **Migrations applied**: `pnpm migrate` (from `apps/api/`)
4. **`.env` configured** with `DATABASE_URL`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`

## Setup

### 1. Seed load test data

From `apps/api/`:

```bash
LOADTEST_USERS=50 LOADTEST_USD_BALANCE=100000 pnpm seed:loadtest
```

This creates N test users and writes `apps/api/load/k6/seed-manifest.json`
(gitignored — contains credentials, do not commit).

### 2. Start API with rate limiting disabled

```bash
DISABLE_RATE_LIMIT=true pnpm dev
```

Rate limiting **must** be disabled for load tests. The login route allows
only 5 req/min per IP and POST /orders allows 60/min — both will throttle
k6 before any application code is stressed.

## Running Scenarios

From `apps/api/` (uses pnpm scripts):

```bash
pnpm load:auth     # Auth smoke (5 VUs, 30s)
pnpm load:reads    # Read-heavy (20 VUs, 60s)
pnpm load:writes   # Trade burst (10 VUs, 60s)
pnpm load:mixed    # Mixed realistic (15 VUs, 90s)
pnpm load:outbox   # Outbox pressure (5 writers + 1 poller, 60s)
```

Or run k6 directly (from repo root):

```bash
k6 run apps/api/load/k6/scenario_auth_smoke.js
k6 run apps/api/load/k6/scenario_read_heavy.js -e K6_BASE_URL=http://localhost:3001
```

### Exporting results for baseline comparison

```bash
mkdir -p apps/api/load/results
k6 run --out json=apps/api/load/results/reads-$(date +%Y%m%d-%H%M%S).json \
  apps/api/load/k6/scenario_read_heavy.js
```

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `K6_BASE_URL` | `http://localhost:3001` | API base URL |
| `LOADTEST_USERS` | `50` | Number of seeded test users |
| `LOADTEST_USD_BALANCE` | `100000` | Starting USD balance per user |

## Viewing Prometheus Metrics

```bash
# Live metrics snapshot
curl http://localhost:3001/metrics

# Key metrics to watch during load
curl -s http://localhost:3001/metrics | grep -E \
  'http_request_duration|http_requests_total|outbox_queue_depth|pg_pool_waiting'
```

## Notes

- k6 scripts are plain `.js` (k6 uses its own JS runtime, not Node.js)
- `seed-manifest.json` is gitignored — regenerate before each test run if DB is reset
- Each VU picks a seeded user by index: `(__VU - 1) % users.length`
- All scenarios share `common.js` for login, auth headers, and HTTP helpers
