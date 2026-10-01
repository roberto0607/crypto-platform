# Landing hero — recon + plan

Recon date: 2026-09-29, against `origin/main` @ 1ae1bd4.
Baseline: API `pnpm test` 63 files / 609 tests passing; web `pnpm test` 27 files / 240 tests passing.

## Recon findings

### Landing page + routing
- `apps/web/src/pages/LandingPage.tsx` (412 lines), mounted at `/` in `App.tsx`.
  Authenticated users are redirected `/` → `/trade`, so **the landing page is
  only ever seen logged-out**.
- Current page: fake boot overlay, custom cursor, a random-walk canvas "chart",
  hardcoded ticker (9 coins incl. BNB/AVAX/DOGE/ARB/OP/LINK with fake prices),
  static red `glitch` "PAPER" headline, 4 duplicate CTAs (ENTER ARENA / CREATE
  ACCOUNT / CLAIM #1 / CLAIM IT NOW), emoji step icons, and a decorative
  `tradr@arena:~$` input that does nothing.

### Frontend stack
- React 18 + Vite + Tailwind + react-router 6 + zustand. Charts:
  lightweight-charts, recharts. **No animation library** — animations are CSS
  keyframes in `index.css` / `tailwind.config.ts`.
- Fonts: Google Fonts `Bebas Neue` + `Space Mono`. No Anton yet.
- SSE client: `@microsoft/fetch-event-source` (`src/api/sse.ts`), authed.
- Tests: vitest + Testing Library, API layer mocked.

### SSE + spectating
- `GET /v1/events` (`routes/v1/v1Events.ts`) — **auth required** (`requireUser`).
  One connection per client; first frame is `stream.ready {streamId}`.
- Spectating is matchId-keyed rooms on the event bus (`subscribeToMatch`),
  joined via `POST /v1/matches/:id/spectate {streamId}` — **auth required**.
  Spectator counts live in Redis SETs `spectators:{matchId}`
  (`matchSpectatorStore.ts`, in-memory fallback).
- `GET /v1/matches/active-list` — auth required; returns full `matches` rows
  (incl. `starting_capital`) + names that **fall back to the email local part**.
  Not safe to reuse as a public payload.
- Web route `/matches/:id/spectate` sits inside `ProtectedRoute` → an
  anonymous visitor clicking SPECTATE is bounced to `/login`.
- Live P&L: `matchPnlEngine.ts` publishes `match.pnl.update
  {matchId, challengerPnlPct, opponentPnlPct}` (≤1/s per match) via the bus.

### Price feed
- Coinbase Advanced Trade WS (`feeds/coinbaseWs.ts`) is the primary source:
  each trade publishes `price.tick {pairId, symbol, last}`. Kraken WS
  (`market/krakenWs.ts`) ticker publishes `price.tick` only as a fallback when
  Coinbase has been silent, and is the only writer of the Redis
  `snap:{symbol}` snapshot (ticker, not trade).
- Symbols are `BTC/USD`, `ETH/USD`, `SOL/USD`.
- **There is no stored "latest BTC-USD trade + timestamp".** Plan: a small
  `latestTradeStore` fed by a global event-bus subscriber on `price.tick`
  for those three symbols, recording `{price, receivedAt}`. Because
  `price.tick` fans out across instances through Redis pub/sub, every API
  instance sees the same stream. Staleness = `now - receivedAt`.

### Redis
- `db/redis.ts`: `getRedis()` returns null when `REDIS_URL` is unset; every
  store follows a Redis/in-memory dual-implementation pattern
  (`snapshotStore.ts`, `matchSpectatorStore.ts`). Tests run without Redis.

### Signup + handles
- `POST /auth/register {email, password, inviteCode?}` — **no handle field.**
- Handle = `users.display_name` (nullable TEXT, migration 044), set later via
  `PUT /v1/profile/display-name`. **Not unique** — no constraint, though that
  route already catches `23505` "if a unique constraint exists".
- Local DB: 2 users have a display name, 0 case-insensitive duplicates.
  **Prod not checked** (needs a read-only query before the migration below
  ships).

### Cookies, proxies, rate limits
- `@fastify/cookie` is registered **without a secret** (no signed cookies).
- Prod web and API are different sites (`*.up.railway.app` is on the Public
  Suffix List). Existing refresh cookie uses `SameSite=None; Secure` in prod,
  `Lax` in dev (`auth/cookieOptions.ts`).
- Fastify is built **without `trustProxy`**, so behind Railway's edge
  `req.ip` is the proxy's address, not the client's.
- `@fastify/rate-limit` is global (200/min, keyed user or IP) and off when
  `DISABLE_RATE_LIMIT=true`.
- All API routes are mounted without an `/api` prefix; the web client's
  `/api` is a Vite dev-proxy prefix (stripped) or `VITE_API_BASE` in prod.

## Assumptions that were false → adaptations

| Spec assumption | Reality | Adaptation |
|---|---|---|
| `/api/quick-call`, `/api/public/...`, `/api/handles/...` | No `/api` prefix server-side; versioned routes live under `/v1` | `POST /v1/quick-call`, `GET /v1/quick-call/current`, `GET /v1/public/landing-stream`, `GET /v1/handles/available`. Browser still calls `/api/v1/...` in dev. |
| Anon cookie `SameSite=Lax` | Cross-site in prod; Lax cookies aren't sent on cross-site fetch | Same rule as the refresh cookie: `None; Secure` in prod, `Lax` in dev. Still httpOnly. |
| "Signed" cookie | cookie plugin has no secret | HMAC-SHA256 signing in the quick-call module, key derived from `JWT_ACCESS_SECRET` with a domain-separation label. No new required env var. |
| 30 calls/hour **per IP** | `req.ip` is Railway's proxy without `trustProxy` → every visitor shares one bucket | New opt-in `TRUST_PROXY_HOPS` env (default 0 = today's behavior). **Must be set on Railway (likely `1`) before the per-IP limit is meaningful** — flagged as a deploy prerequisite, not flipped silently, since it also changes the existing global limiter's keying. |
| Handles are unique; signup takes a handle | Neither | Migration adds a partial unique index on `lower(display_name)`; `/auth/register` accepts optional `displayName`; availability = format-valid + not taken. **Merge gate: run a read-only duplicate check on prod first** (a duplicate would fail the migration and the API boot). |
| "Result pushed over the stream" (identity on a public SSE) | Event bus targets users/matches, not anon sessions | Settlement publishes `quickcall.settled` with `userId = <identity key>`; the landing-stream module has one global subscriber that fans results out to local connections holding that identity. Works cross-instance via existing Redis pub/sub. |
| Featured match "returns %" | Available only as live `match.pnl.update` events | Landing module caches the latest update + a short series per active match. Instances that haven't seen an update yet send `null` returns (UI hides them). |
| UI needs "equity lines racing", "$ P&L", "trade markers" | Spec payload has only returns % and last 3 trades | Payload adds `series` (recent `[t, challengerPct, opponentPct]` points, in-memory, capped), `pnlUsd` per player (`pct × starting_capital`, P&L only — no balances), and a timestamp on each trade for markers. |
| Handles for featured players | `listActiveMatches` falls back to email local part | Public query uses `display_name` only; `null` when unset (UI shows the role label, never the email). |
| SPECTATE links to spectate view | That route requires login | Link kept as-is (`/matches/:id/spectate`); anonymous visitors hit the login wall. Making spectate public is out of scope. |
| Quick-call settles at entry+60s | Nothing in the stack runs deferred jobs per request | In-process timer on the receiving instance; state in Redis. If the instance dies before settling, the call becomes **void** on next read (no price at t+60 was recorded) — honest, streak unchanged. |

## Build plan

**PR 1 — quick-call backend** (`feat/quick-call-backend`)
- `src/quickCall/`: `identity.ts` (signed anon cookie / user), `latestTradeStore.ts`,
  `quickCallStore.ts` (Redis + in-memory), `quickCallService.ts` (pure settle rule +
  place/settle/current/transfer), `rateLimit.ts`.
- `routes/v1/v1QuickCall.ts`; streak transfer hooked into login + register.
- Tests: settle rule (win/loss/push/void), double-call 409, IP rate limit 429,
  streak transfer, client-supplied price/result ignored (schema rejects extra
  props), cap at 5.

**PR 2 — public landing stream** (`feat/landing-stream`)
- `src/landing/`: featured-match selector (pure, tested), public payload builder
  (allow-listed fields only), broadcaster (one shared 2/s tick loop).
- `routes/v1/v1Public.ts`: `GET /v1/public/landing-stream`, `GET /v1/handles/available`.
- Migration: unique handle index; `/auth/register` accepts `displayName`.
- Tests: no private fields (recursive key scan), `null` when no live match,
  selector ordering, handle availability.

**PR 3 — landing UI** (`feat/landing-hero`)
- Rewrite `LandingPage.tsx` into small components; `useLandingStream` hook.
- Tests for both panel states, the "finish the round before switching" rule,
  hidden-when-missing numbers. Lighthouse run against `vite preview`.
