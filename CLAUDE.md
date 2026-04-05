# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

TRADR is a competitive crypto paper trading platform. Users trade BTC/ETH/SOL with simulated balances, compete in 1v1 matches with ELO rankings, and analyze markets with professional-grade chart indicators.

- **Monorepo**: pnpm workspaces — `apps/api/` (Fastify/TypeScript) + `apps/web/` (Vite/React)
- **Database**: PostgreSQL 16 via raw SQL (`pg` pool, no ORM) + Redis for distributed state
- **Deployment**: Railway — separate web and API services
  - Frontend: `gallant-reprieve-production.up.railway.app`
  - API: `crypto-platform-production-691d.up.railway.app`
- **Auth**: Argon2 + JWT access tokens + HttpOnly refresh cookie rotation
- **Trading**: Simulated order book with limit/market orders, slippage model, TP/SL/trailing stop triggers

## Build & Development Commands

All commands run from `apps/api/`:

```bash
pnpm dev              # Start dev server with hot reload (tsx watch, port 3001)
pnpm typecheck        # Type-check without emitting (tsc --noEmit)
pnpm migrate          # Run database migrations
```

Start PostgreSQL before running the API:
```bash
docker compose up -d  # Start PostgreSQL (port 5433) + Redis
```

## Indicator Roadmap

### Already Built
EMA 20/50/200, VWAP, Bollinger Bands, Volume bars, RSI(14), CVD, Key Levels (PDH/PDL), Liquidity Zones, Order Blocks, Market Intelligence composite score

### Stage 1 (next priority)
- MACD (12/26/9)
- ATR (Average True Range, 14-period)
- Per-candle delta (buy volume - sell volume as histogram)

### Stage 2
- Funding Rate overlay (Binance public API)
- Open Interest chart (Binance public API)

### Stage 3
- Volume Profile / VPVR (price-level volume histogram)

### Stage 4
- Order Book Heatmap
- Footprint Charts
- Absorption detection

### Stage 5
- Liquidation Levels (exchange aggregated)
- COT Report integration
- Multi-exchange Open Interest

### Stage 6
- Post-Match Replay — replay a completed 1v1 match candle-by-candle with both players' trades overlaid (priority competitive feature)

**Rule**: Build each indicator correctly before moving to the next. No deadlines. Quality over speed.

## Architecture Rules

### Indicators
All new indicators follow this pattern:
1. Computation function in `apps/web/src/lib/indicators.ts`
2. Boolean toggle in `defaultIndicatorConfig` in `apps/web/src/stores/tradingStore.ts`
3. Entry in `IndicatorToolbar.tsx` (STANDARD or ADVANCED section)
4. Overlay indicators: add `LineSeries` in `CandlestickChart.tsx` `renderOverlays()`
5. Sub-panel indicators: create a synced panel component like `CvdPanel.tsx` / `RsiPanel.tsx`
6. All indicator defaults are OFF — user enables what they want
7. Sub-panels use time-based range sync (`getVisibleRange`/`setVisibleRange`), not logical index

### Sub-Panel Height Constants
- Minimum height: 40px (drag clamp)
- Default expanded: 80px (Volume, RSI, Delta), 100px (MACD), 120px (ATR), 60px (CVD)
- Collapsed height: 20px (SubPanelHeader label bar only)
- Maximum height: 400px (drag clamp)
- Heights persisted in localStorage key `tradr_panel_heights`

### Auth & Cookies
- Production uses `sameSite: "none"` + `secure: true` (cross-origin Railway deployment)
- Dev uses `sameSite: "lax"` (Vite proxy makes it same-origin)
- **Never change cookie config without checking `config.isProd` condition**

### Error Handling
- Never use `process.exit()` silently — always log before exiting
- Migration guard throws errors (not `process.exit`) so they propagate to the top-level catch

### Triggers (TP/SL)
- Frontend trigger endpoints use `/v1/triggers` and `/v1/oco` prefix
- Fastify JSON schema must match Zod schema for all allowed `kind` values
- `TRAILING_STOP_MARKET` requires `trailingOffset` in both schemas

## Known Issues (do not re-introduce)

- **Multi-tab token refresh race**: Two browsers/tabs as the same user can trigger concurrent refresh rotations, causing token reuse detection and family revocation. Deferred — known limitation of the rotation security model.
- **Demo user created directly in DB**: The `demo@demo.local` account was not created through the normal auth flow. Always verify wallets exist before match start. Wallets were manually inserted.
- **`orders.competition_id` FK points to `competitions` table, NOT `matches`**: Do not set `activeCompetitionId` to a match UUID — it causes FK violation on order placement.

## Database

- **Production**: `postgresql://postgres:***@shuttle.proxy.rlwy.net:30809/railway`
- **Local dev**: `postgresql://cp:cp@localhost:5433/cp`
- **Migrations**: Plain SQL in `apps/api/migrations/`, tracked in `schema_migrations`. Always register in `schema_migrations` when applying manually.
- **Demo user ID**: `5b44aeb6-81c4-4131-bd06-b87e6fe89f11`
- **Rtirado user ID (production)**: `338d993f-0444-4a0a-b463-d3cb6ce0d959`

## Coding Principles

- **Diagnose before fixing** — always show relevant code and findings before suggesting changes
- **Permanent fixes only** — no patches that mask root causes
- **Commit after each logical fix** — not batched across unrelated changes
- **Frontend validation never replaces backend validation** — both are required
- **Typecheck before committing**: `cd apps/api && npx tsc --noEmit` and `cd apps/web && npx tsc --noEmit`

## Key Patterns

- **No ORM** — all database access uses raw SQL via `pg` Pool
- **Audit logging** — `audit_log` table captures actor, action, target, request context, and JSONB metadata
- **Refresh token rotation** — tokens stored as hashes with expiry, reuse detection, and family revocation
- **Paper trading** — platform uses simulated balances only; `debitUnconstrainedTx()` allows negative balance for short sells
- **Order-book exchange model** — market maker bot provides liquidity; real limit order matching with price-time priority

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `DATABASE_URL` | **yes** | — | PostgreSQL connection string |
| `JWT_ACCESS_SECRET` | **yes** | — | HMAC secret for access tokens |
| `PORT` | no | `3001` | HTTP listen port |
| `HOST` | no | `0.0.0.0` | HTTP listen host |
| `NODE_ENV` | no | `development` | `development` or `production` |
| `CORS_ORIGINS` | no | localhost:5173,3000 | Comma-separated allowed origins |
| `REDIS_URL` | no | — | Redis connection (empty = local-only mode) |
| `DISABLE_RATE_LIMIT` | no | `false` | Skip rate limiting (dev/load test) |
| `DISABLE_JOB_RUNNER` | no | `false` | Skip background jobs (load test) |

# Stage 2 deployed: Funding Rate + Open Interest
