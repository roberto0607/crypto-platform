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
docker compose up -d  # Start PostgreSQL (port 5435) + Redis
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

- **Production**: Use Railway's `DATABASE_PUBLIC_URL` for local→production queries. Fetch the current value at use time via `railway run --service Postgres bash -c 'echo $DATABASE_PUBLIC_URL'` — do not embed it (even masked) in tracked files.
- **Local dev**: `postgresql://cp:cp@localhost:5435/cp`
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

## Visual verification: Playwright MCP

Playwright MCP is wired into Claude Code at user scope. Use it BEFORE
asking Roberto for DevTools screenshots — it pays for itself the moment
the question is "does this element exist / what are its computed styles
/ does it overlap something."

### When to reach for it

- Any "is X rendering?" question about the running app
- DOM structure / computed style questions (width, display, flex,
  overflow, min-width)
- "Does the layout break at viewport Y?"
- Smoke-testing a UI change end-to-end before committing
- Reproducing a visual bug Roberto described

Do NOT use it for: questions answerable from source code alone, unit
test failures, type errors, or anything where the answer is in the repo.

### How to invoke

Mention "playwright mcp" explicitly the first time in a session:

    Use playwright mcp to open http://localhost:5173/trade and ...

After the first call, "use playwright" or "open the page" is enough.

### Prereqs the tool needs

- Dev servers must be running on :5173 (web) and :3001 (api). If they're
  not, start them yourself with `pnpm dev` in the respective app dir,
  background them with `>/tmp/tradr-{api,web}.log 2>&1 &`, and poll
  with curl until both return 200 before navigating.
- /trade requires auth. There's no .env with test credentials. Options:
  ask Roberto, or register a fresh throwaway account via the signup
  flow (local DB gets reseeded regularly so throwaways are cheap).

### Diagnostic prompt template

For DOM/CSS investigations, capture data structurally rather than just
screenshots — screenshots are good for the final visual but bad for
answering questions like "what's the computed flex value":

1. Navigate, wait for the target component to render
2. querySelectorAll the parent, list every child's className +
   computed width + display + flex
3. For specific suspects, dump display, flex, min-width, width,
   max-width, overflow
4. Test at multiple viewport widths if a media query might be involved
5. Screenshot final state for Roberto's visual confirmation

### Verify the correct selector before reporting "missing"

A null querySelector result means EITHER the element doesn't exist OR
the selector is wrong. Always grep the source for the class name first:

    grep -rn "tr-cr-ohlc" apps/web/src

If the class doesn't appear in source, the selector is wrong. Don't
report "missing from DOM" until you've confirmed the class name is
spelled correctly. (Real example from May 2026: `.tr-cr-ohlcv` was
queried for an hour before it turned out the actual class is
`.tr-cr-ohlc` — no V.)

### Privacy note

Everything Playwright sees goes to Anthropic's API as tool input. Fine
for localhost with fake/paper-trading data. Don't point it at Railway
prod with real account state unless Roberto explicitly asks.

# Recently shipped

- **Stage 2 deployed: Funding Rate + Open Interest** (Binance public API overlays)

## Match-scoped positions bug (FIXED 2026-05-22, PR #26)

The Redis queue flattened `matchId = undefined` (the route's "look it up
server-side" signal) to `""` at enqueue and back to `null` at dequeue, so every
in-match order/position in prod was written with `match_id = NULL`. Worked
locally because the in-memory queue preserved `undefined`; broke under Redis
only.

Four downstream consequences, all healed by the same fix:
- LMV positions invisible (read filter `WHERE match_id = $activeMatchId` found
  nothing → no close button → users forfeited to escape)
- Orphan positions appeared on free-play `/trade` after forfeit
  (`WHERE match_id IS NULL` matched)
- `cancelActiveMatch`'s "has filled trades?" gate was structurally 0 (reopened
  the cancel-to-dodge-ELO exploit that 7924b58 was supposed to close)
- `closeMatchScopedPositions` on completeMatch/forfeitMatch found zero rows
  (match P&L missed in-match positions)

Prod evidence at fix time: 42 FILLED orders across 8 distinct matches placed
with `match_id = NULL`; 7 of 8 matches FORFEITED, confirming the behavioral
hypothesis. Migration 066 confirmed applied 2026-04-25 — column existed, queue
write path stopped populating it.

Fix: resolve `matchId` at the HTTP edge in `tradingRoutes.ts` (call
`getActiveMatchIdForUser` before enqueueing) and carry concrete `string | null`
through the queue. Across Redis, `null` serializes as a distinct
`__free_play__` sentinel (never `""`); dequeue maps it back symmetrically, with
`""`/missing defensively mapped to `null` for backward compat with pre-fix
queued jobs. `phase6OrderService`'s `getActiveMatchIdForUser` fallback was
REMOVED — a wrong null now surfaces as the symptom rather than being silently
re-resolved.

Verified end-to-end in prod 2026-05-22 12:01 PM: challenged demo from
rtirado0607, both sides in LMV opened opposite positions, CLOSE POSITION button
appeared in both, positions closed cleanly with P&L recorded.

Existing orphans NOT bulk-cleaned — closed manually as encountered. The fix
only prevents new orphans.

Known follow-ups (backlog, not blocking):
- Race window: order placed at match-completion boundary could stamp a
  just-ended matchId. Mitigation: closeMatchScopedPositions sweep after match
  completion (already runs, but could drain in-flight queue jobs first).
- Add a Redis-queue integration test so this class of bug can't regress
  silently (existing tests only exercised the in-memory path).
- Extract custom-header allowlist to shared constants module (so client
  interceptor + server CORS can't drift like X-Competition-Id did — same shape
  of bug as the matchId one).

# Top of mind

TRADR is in a **stable foundation, ready for next features** state. The dev DB
was restored, the test suite is green (239/239), and the most recently shipped
work is the match-scoped positions fix above (PR #26). Next priorities follow
the Indicator Roadmap (Stage 1: MACD / ATR / per-candle delta).
