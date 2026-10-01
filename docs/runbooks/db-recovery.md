# Runbook: Postgres recovery onto a new Railway service

**When:** the production Postgres service crashed because its volume filled up.
This moves the API onto a **new, empty** Postgres service that runs under the
storage budget from `fix/db-recovery`.

**Never touch the old Postgres service.** Don't delete, restart, redeploy,
resize or detach its volume. It keeps the only copy of the pre-crash data.

> ⚠️ **The new database starts empty.** User accounts, wallets, matches, ELO and
> chat history stay on the old volume. Everyone has to register again unless that
> data is recovered from the old volume later, which is a separate task this
> runbook doesn't cover. Market-data history is re-downloaded in step 7.

Time needed: about 45 minutes, most of it waiting on the backfill (~11 min).

---

## 0. Prerequisites

- [ ] The `fix/db-recovery` PR is merged to `main`. Its **Docker Build** CI check is green.
- [ ] Local checkout of `main` that is up to date, with deps installed: `cd apps/api && pnpm install`.
- [ ] Railway CLI is logged in and linked to the TRADR project: `railway status`.
- [ ] `psql` is installed locally (`which psql`).
- [ ] `apps/api/.env` exists locally. The scripts below read `JWT_ACCESS_SECRET` from it
      at import time, and the value doesn't matter for them. They take `DATABASE_URL`
      from the command, which overrides `.env`.

**Secrets discipline** (CLAUDE.md): always pass `--service` to `railway` commands.
Never `echo` a connection string. The commands below only pass
`$DATABASE_PUBLIC_URL` through to a child process, so it never gets printed.

In the commands below, `<NEW_PG>` is the name you give the new service in step 1
(this doc assumes **`Postgres-v2`**).

---

## 1. Create the new Postgres service

1. Open the TRADR project in the Railway dashboard.
2. On the project canvas, click **+ Create** (top right). Choose **Database**, then **Add PostgreSQL**.
3. Wait for the new service to show **Active**. Click it, then go to **Settings**, then **Service Name**,
   and rename it to **`Postgres-v2`**.
4. Find the volume size. The new service's volume shows as its own card on the canvas,
   attached to `Postgres-v2`. Click it and note the **size** (e.g. 5 GB). You need it in
   step 5 as `DB_SIZE_LIMIT_MB` (GB × 1024).
   - If the volume is **smaller than 3 GB**, grow it before going on (volume card, then
     **Settings**, then size). Expected steady-state volume use is **≤ 1.5 GB**, including WAL (see Sizing at the end).
5. Make sure the old **`Postgres`** service still shows its original state. You haven't
   clicked anything on it.

## 2. Run migrations against the new database (from your laptop)

```bash
cd apps/api
railway run --service Postgres-v2 -- bash -c 'DATABASE_URL="$DATABASE_PUBLIC_URL" pnpm migrate'
```

Expected: `Applied 001_…` through the latest migration (`092_…` or later), then exit 0.
It's safe to re-run, since already-applied migrations are skipped.

## 3. Seed the live-feed symbol map (from your laptop)

A fresh database has the BTC/ETH/SOL trading pairs (seeded by migrations) but no
`exchange_symbol_map` rows. Without them the Kraken/Coinbase feeds subscribe to
nothing, and the `symbol-refresh` job doesn't run until 6 h after boot. This step
fills the map now. It **streams** the top-30 Kraken ∩ Coinbase pairs live.
Only `MARKET_SYMBOLS` pairs get history **stored**.

```bash
# preview first (writes nothing)
railway run --service Postgres-v2 -- bash -c 'DATABASE_URL="$DATABASE_PUBLIC_URL" npx tsx scripts/backfillExchangeSymbols.ts'
# then write
railway run --service Postgres-v2 -- bash -c 'DATABASE_URL="$DATABASE_PUBLIC_URL" npx tsx scripts/backfillExchangeSymbols.ts --commit'
```

Expected: the preview lists BTC/USD, ETH/USD and SOL/USD among the pairs. `--commit` exits 0.

## 4. Point the API at the new database

1. Click the API service **`crypto-platform`**, then **Variables**.
2. Click `DATABASE_URL` and edit it. Replace the value with the **reference**
   `${{Postgres-v2.DATABASE_URL}}`. Type it exactly like that; Railway autocompletes `${{`.
   - Use the reference, not a pasted literal. A reference follows password rotations
     automatically, and a literal goes stale (CLAUDE.md, Railway secrets discipline).
   - The reference resolves to the private-network URL, which is what the API should use.
3. Don't save-and-deploy yet. Railway stages variable changes until you deploy, so
   go straight to step 5 in the same Variables tab.

## 5. Set the new environment variables (same Variables tab)

Add or confirm each one with **+ New Variable**:

| Variable | Value | Why |
|---|---|---|
| `AGENTS_ENABLED` | `false` | Master switch for all agents. It's already the prod default; setting it makes that explicit. |
| `MARKET_SYMBOLS` | `BTC-USD,ETH-USD,SOL-USD` | The only pairs whose candles and footprint are written. Same as the default. |
| `DB_SIZE_LIMIT_MB` | volume size from step 1.4 in MB (5 GB → `5120`) | Turns on the 70% warn and 85% pause guardrail. |

Optional. These are already the code defaults, so add them only to change them:
`DB_SIZE_WARN_PCT=70`, `DB_SIZE_CRITICAL_PCT=85`,
`RETENTION_CANDLE_1M_DAYS=30`, `RETENTION_CANDLE_5M_DAYS=365`,
`RETENTION_CANDLE_15M_DAYS=365`, `RETENTION_AGENT_RUN_LOG_DAYS=14`,
`RETENTION_OUTBOX_DONE_DAYS=7`, `AGENT_LOG_SAMPLE_RATE=0.05`,
`AGENT_LOG_HEARTBEAT_MINUTES=30`.

Leave these as they are: `NODE_ENV=production`, `JWT_ACCESS_SECRET`, `REDIS_URL`,
`CORS_ORIGINS`, `BOT_USER_ID`, `TRUST_PROXY_HOPS`, and any `*_AGENT_ENABLED` flags.
`AGENTS_ENABLED=false` overrides those flags anyway.

## 6. Deploy

1. At the top of the canvas, click **Deploy** (or **Apply N changes**, then **Deploy**)
   to apply the staged variables. Railway redeploys `crypto-platform` from `main`.
2. Open **Deployments**, select the new deployment, and check both log tabs:
   - **Build logs:** the Docker build finishes. `pnpm install --frozen-lockfile` succeeds, then `tsc`.
   - **Deploy logs:** look for, in order:
     - `[boot] Running migration guard…` with no `DB_BEHIND`/`DB_EMPTY` error
     - `Server starting` with `devMode.agentsEnabled: false`
     - a `db_size` line with `limitMb` equal to your `DB_SIZE_LIMIT_MB` and `level: "ok"`.
       If it says `DB_SIZE_LIMIT_MB is not set`, step 5 didn't apply.
     - `kraken_ws_subscriptions_reconciled` / Coinbase connect lines
     - `candle_backfill_complete`: the 7-day boot backfill, MARKET_SYMBOLS pairs only
3. The deployment shows **Active**, and the web app loads and lets you register a new account.

## 7. Run the history backfill (from your laptop)

Re-downloads full 1d/1h history plus 365 days of 15m/5m and 30 days of 1m for
BTC/ETH/SOL from Coinbase's public candles endpoint (no key, US-accessible), at 4 req/s.

```bash
cd apps/api
# plan only, writes nothing
railway run --service Postgres-v2 -- bash -c 'DATABASE_URL="$DATABASE_PUBLIC_URL" pnpm backfill:history --dry-run'
# run (~11 min, ~2,700 requests, measured)
railway run --service Postgres-v2 -- bash -c 'DATABASE_URL="$DATABASE_PUBLIC_URL" pnpm backfill:history'
```

- It's safe to Ctrl-C and re-run. Each page is committed as it's fetched, and a re-run
  resumes from the newest candle of every series (1d always re-walks, ~12 requests per symbol).
- If it reports gaps later, for example after API downtime, run it with `--force`.
  That refetches every window, and the upserts leave nothing duplicated.
- It ends with a per-timeframe table and `candles table … MB · database … MB`.

## 8. Verify

**Data** (from your laptop):

```bash
railway run --service Postgres-v2 -- bash -c 'psql "$DATABASE_PUBLIC_URL" -c "
  SELECT tp.symbol, c.timeframe, count(*), min(c.ts)::date AS oldest, max(c.ts) AS newest
  FROM candles c JOIN trading_pairs tp ON tp.id = c.pair_id
  GROUP BY 1, 2 ORDER BY 1, 2;"'
```

- [ ] Only `BTC/USD`, `ETH/USD`, `SOL/USD` appear, even though ~30 pairs stream live.
- [ ] Each symbol has `1m 5m 15m 1h 4h 1d 1w`. `1m` reaches back about 30 days, `5m`/`15m` about 365 days.
      `1h`/`1d` start at the listing: about 2015 for BTC, 2016 for ETH, 2021 for SOL.
- [ ] `newest` for `1m` is within a couple of minutes of now, which means the live feed is writing.

```bash
railway run --service Postgres-v2 -- bash -c 'psql "$DATABASE_PUBLIC_URL" -c "
  SELECT pg_size_pretty(pg_database_size(current_database())) AS db,
         pg_size_pretty(pg_total_relation_size(''candles'')) AS candles;"'
```

- [ ] The database is in the hundreds of MB, not GB. See the sizing table below.

**App:**
- [ ] On `/trade`, BTC/USD, ETH/USD and SOL/USD charts render history on every timeframe (1m through 1w).
- [ ] Another streamed pair (e.g. a top-30 alt) shows a live price and updates live,
      but has no history. That's expected.
- [ ] A market order on BTC/USD fills.

**Jobs and guardrail** (about 1 h after deploy):

```bash
railway run --service Postgres-v2 -- bash -c 'psql "$DATABASE_PUBLIC_URL" -c "
  SELECT job_name, last_status, last_finished_at FROM job_runs
  WHERE job_name IN (''storage-retention'', ''retention'', ''candle-rollup'', ''kraken-candle-sync'')
  ORDER BY 1;"'
```

- [ ] `storage-retention` and `retention` show `SUCCESS`. The API logs show
      `storage_retention_complete`, and a second `db_size` line about 1 h after the first.

## Rollback

The old database is crashed, so "rollback" only means undoing the code. To roll
back, open the `crypto-platform` service, go to **Deployments**, find the previous
deployment, and click **⋯** then **Redeploy**. Keep
`DATABASE_URL=${{Postgres-v2.DATABASE_URL}}`. The older code runs fine on the new
schema, but it has no allowlist, retention or guardrail, so it will grow without bound again.

## Guardrail behavior (reference)

| DB + WAL as % of `DB_SIZE_LIMIT_MB` | What happens |
|---|---|
| < 70% | `db_size` info log every hour |
| ≥ 70% | `db_size_warning` warn log, re-checked every 5 min |
| ≥ 85% | `DB_SIZE_CRITICAL … PAUSED` error log. Scanner, chart-analysis and news agents skip their cycles, `agent_run_logs` and footprint candles stop being written, re-checked every 5 min |
| back < 85% | `db_size_recovered: non-essential writes resumed` |

Trading, auth, audit, allowlisted candles and retention are never paused.
Retention is what brings the size back down. Note that Postgres reuses freed
space but doesn't hand it back to the volume. A sustained warn means the budget
needs tuning or the volume needs to grow.

## Sizing (measured)

Measured 2026-10-01 by running `pnpm backfill:history` (real Coinbase data)
into a freshly migrated local Postgres 16. Result: 2,668 requests in 11m11s.

| Timeframe | Rows (BTC+ETH+SOL) | Window |
|---|---:|---|
| 1m | 129,600 | 30 d (at cap) |
| 5m | 314,911 | 365 d (at cap) |
| 15m | 104,976 | 365 d (at cap) |
| 1h | 235,195 | full history (BTC 2015-07, ETH 2016-05, SOL 2021-06) |
| 4h | 58,837 | rolled up from 1h |
| 1d | 9,809 | full history |
| 1w | 1,401 | rolled up from 1d |
| **Total** | **854,729** | **candles 221 MB** (heap 95 MB, `candles_pkey` 61 MB, `idx_candles_lookup` 76 MB) · **database 232 MB** |

That works out to about **271 bytes per candle row** including both indexes.

**Expected steady state:**
- **Candles:** 1m, 5m and 15m are already at their retention caps, so they stay flat.
  Only the coarse series grow, by about 34k rows/year (1h 26,280 + 4h 6,570 + 1d 1,095 + 1w 156),
  which is **about 9 MB/year**.
- **Upsert churn on live 1m rows:** the Kraken sync re-upserts the last 15 minutes every
  minute, so autovacuum'd dead tuples add headroom. Budget **250–350 MB for candles**.
- **Everything else:** users, orders, ledger, 24 h of footprint, 7 d of outbox and 14 d of
  agent logs (agents off) adds tens of MB at current load.
- **Database:** about **0.3–0.4 GB**.
- **WAL:** it sits on the same volume and can grow to `max_wal_size`, which is 1 GB by default.
  It measured 384 MB right after the backfill. The guardrail counts it.

Plan on **≤ 1.5 GB of volume usage**. On a 5 GB volume that's about 30%, well under the 70% warn line.

**Before (for comparison):** every auto-synced pair was stored. That was 137 pairs locally,
growing toward the top 75 by volume in prod, across 7 timeframes with no candle retention.
That's about 1,855 rows per pair per day, or 0.5 MB per pair per day. For 137 pairs that's
**about 69 MB/day (~2 GB/month), growing without bound**. Now it's about 9 MB/year.

**Retention timing on this data:** a steady-state hourly run finished in 69 ms. A forced
backlog (shrinking the 1m window from 30 to 7 days, 99,360 rows) cleared in 2.3 s across
20 batches of 5,000 rows each.
