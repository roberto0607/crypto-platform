# Gate 1 Design Lock: Dynamic Multi-Asset Feeds + Charting Library Datafeed + Subscription Scaling

Status: **DESIGN ONLY — awaiting sign-off before Gate 2 implementation.**
Scope: expand TRADR's tradable symbol set beyond BTC/ETH/SOL (Kraken + Coinbase
only — Binance/Bybit ruled out, US Railway geo-block, same reason Stage 2
funding/OI avoided them), and build a TradingView Charting Library-compatible
datafeed adapter with per-connection subscription scaling.

Prior art referenced throughout: Gate 0 recon (market data architecture, SSE/eventBus,
indicator patterns).

---

## 1. Railway Postgres constraint — VERIFIED

Ran directly against Railway production Postgres (`DATABASE_PUBLIC_URL`, fetched
live via `railway run --service Postgres`, not embedded anywhere):

```
SELECT * FROM pg_available_extensions WHERE name = 'pg_trgm';

  name   | default_version | installed_version |  comment
---------+-----------------+--------------------+------------------------------------
 pg_trgm | 1.6             | (null — not yet installed) | text similarity... trigrams
```

**`pg_trgm` is available and NOT a blocker.** It just needs
`CREATE EXTENSION IF NOT EXISTS pg_trgm;` in a migration — it's a "trusted"
extension since PG13, installable without superuser.

Side finding, not blocking but worth recording: **Railway production Postgres is
version 18.3** (`PostgreSQL 18.3 (Debian 18.3-1.pgdg13+1)`), while local dev
(`docker-compose.yml`) pins `postgres:16`. `pg_trgm` behaves identically across
both, so this doesn't affect this design — but it means any future migration
that depends on version-specific syntax should be checked against 18, not 16.
Recommend bumping the local compose image to 18 in a separate follow-up so
local/prod stay matched (not part of this workstream).

`pg_bigm` was checked as a fallback candidate and is **not** in
`pg_available_extensions` on Railway — moot since `pg_trgm` is available, but
confirms there's no CJK-tokenization option if that's ever needed later.

**Decision: use `pg_trgm` GIN index on `lower(symbol)` for `searchSymbols`.**
Fallback design (documented for completeness, not needed): plain
`btree` index on `lower(symbol)` + `ILIKE 'prefix%'` queries would cover
prefix search (autocomplete-style) without any extension, but wouldn't support
substring/typo-tolerant search mid-string. Since `pg_trgm` is confirmed
available, go straight to trigram — no need for the degraded fallback path.

```sql
-- migration N: symbol trigram search
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX idx_trading_pairs_symbol_trgm
    ON trading_pairs USING GIN (symbol gin_trgm_ops);
```

---

## 2. Symbol map refactor (Kraken + Coinbase only)

### 2.1 Current state (from Gate 0)

Three independent hardcoded maps, each listing only `BTC/USD`, `ETH/USD`,
`SOL/USD`:
- `krakenWs.ts` → `SYMBOL_MAP` (our symbol → Kraken WS v2 symbol, identity for BTC/ETH/SOL)
- `coinbaseWs.ts` → `PRODUCT_MAP` (our symbol → Coinbase product ID, e.g. `BTC-USD`)
- `krakenRest.ts` → `REST_PAIR_MAP` (our symbol → Kraken REST pair name, e.g. `XBTUSD` — note REST uses different naming than WS v2)
- `coinbaseRest.ts` / `candleBackfill.ts` → `CB_PAIR_MAP` (our symbol → Coinbase product ID, duplicate of `PRODUCT_MAP`)

`trading_pairs` (DB) is already the dynamic source of truth for the UI
(`GET /pairs`, `PairSelector.tsx`) — the bottleneck is purely that the feed
layer doesn't read from it beyond `listActivePairs()` at boot to resolve
`symbol → pairId`, and it does nothing with symbols that aren't already in
the hardcoded maps.

Each new pair also needs two rows in `assets` (base + quote) before a
`trading_pairs` row can reference them — `pairs_assets_unique` and
`pairs_symbol_unique` constraints already enforce no duplicates.

### 2.2 Populating `trading_pairs`

**New table: `exchange_symbol_map`** — replaces the four hardcoded literal
objects with data. This is the actual deliverable of this section; without
it there's nowhere to persist "Kraken calls this `XBTUSD` on REST but
`BTC/USD` on WS v2, Coinbase calls it `BTC-USD` everywhere."

```sql
CREATE TABLE exchange_symbol_map (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pair_id UUID NOT NULL REFERENCES trading_pairs(id) ON DELETE CASCADE,
    exchange TEXT NOT NULL CHECK (exchange IN ('kraken', 'coinbase')),
    ws_symbol TEXT NOT NULL,       -- e.g. Kraken WS v2 "BTC/USD", Coinbase "BTC-USD"
    rest_symbol TEXT NOT NULL,     -- e.g. Kraken REST "XBTUSD", Coinbase "BTC-USD"
    is_active BOOLEAN NOT NULL DEFAULT true,  -- exchange delisted but pair may still exist elsewhere
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT exchange_symbol_map_unique UNIQUE (pair_id, exchange)
);
CREATE INDEX idx_exchange_symbol_map_active
    ON exchange_symbol_map (exchange) WHERE is_active = true;
```

**One-time backfill script** (`apps/api/src/scripts/backfillExchangeSymbols.ts`,
run manually, not on boot):
1. `GET https://api.kraken.com/0/public/Assets` and
   `GET https://api.kraken.com/0/public/AssetPairs` — cross-reference to get
   every USD-quoted spot pair Kraken lists, its WS v2 name (`wsname` field in
   `AssetPairs` response) and REST pair key.
2. `GET https://api.coinbase.com/api/v3/brokerage/market/products` (public,
   no auth per existing `coinbaseRest.ts` comment) — filter `quote_currency_id
   == "USD"`, `trading_disabled == false`.
3. Intersect: only create a `trading_pairs` row for a base asset that exists
   on **both** exchanges (dual-sourcing is the entire reason the platform has
   two feeds — Kraken primary, Coinbase secondary/backfill; a single-exchange
   symbol breaks that redundancy model silently).
4. For each intersected symbol: upsert `assets` (base + quote if not present),
   upsert `trading_pairs`, upsert two `exchange_symbol_map` rows (kraken +
   coinbase).
5. Idempotent via `ON CONFLICT DO UPDATE` on all three tables — safe to
   re-run.

**Periodic refresh job** (`apps/api/src/jobs/definitions/symbolRefreshJob.ts`,
registered in the existing job runner alongside `marketMakerJob.ts`,
respects `DISABLE_JOB_RUNNER`):
- Runs the same fetch-and-intersect logic on an interval (proposed: every 6h
  — new listings are not a latency-sensitive event, and both exchanges rate-
  limit aggressively on public endpoints).
- **New pair appears on both exchanges**: upsert as above, `is_active = true`.
  No process restart needed — see 2.3 for how live feeds pick it up.
- **Pair delisted on one exchange** (`AssetPairs` / `products` no longer
  returns it, or returns `trading_disabled: true`): set
  `exchange_symbol_map.is_active = false` for that exchange row. Do **not**
  auto-flip `trading_pairs.is_active` off the strength of one exchange —
  require both `exchange_symbol_map` rows inactive before disabling the
  pair, since Kraken-down-but-Coinbase-up is exactly the redundancy case this
  should tolerate, not punish.
- Structured logging on every add/deactivate (`symbol_refresh_pair_added`,
  `symbol_refresh_exchange_delisted`) — this changes the tradable universe,
  should be audit-visible the same way other state changes are.

### 2.2.1 Addendum — wallet provisioning (recon + Gate 2 implementation)

Recon done between Gate 1 and Gate 2 found that wallet creation is **eager
at signup, keyed to the `assets` table (not `trading_pairs`)** —
`autoCreateWallets()` (`apps/api/src/wallets/autoWallets.ts`) cross-joins
`assets` for the registering user only, and is called from nowhere else
automatically. `FREE_PLAY_CREDIT` is safe against duplication regardless
(scoped to the single USD wallet via a partial unique index, migration
070), but the wallet-creation side has a real gap: **nothing reacts to a
new `trading_pairs`/`assets` row for *existing* users.** Adding new pairs
via this section's backfill script/job would otherwise make those pairs
tradable on the market-data side while `matchingEngine.ts` hard-throws
`wallet_not_found` for every existing user trying to trade one (no lazy
wallet-create fallback).

**Gate 2 implementation, and a deviation from what this section originally
sketched**: rather than new bulk-insert SQL, `upsertCandidate()`
(`apps/api/src/market/symbolSync.ts`) reuses `autoCreateWallets(userId,
null, client)` in a loop over every existing user (`SELECT id FROM
users`), for each **newly created** base asset only, inside the same
transaction as the `trading_pairs`/`exchange_symbol_map` upserts and
**before** the pair flips to `is_active = true` — matching the ordering
this section already specified. This is less new code than a bespoke
cross-join, and matches the precedent already established by
`backfill-freeplay-capital.ts` (looping a per-user provisioning function
over all users). At the platform's current "tiny user load" (per project
memory) a per-user loop inside one transaction is fine; flagged as a
future chunking concern only if the user base grows substantially.

### 2.3 Feed layer: from hardcoded maps to DB-driven, live-refreshable

Replace `SYMBOL_MAP` / `PRODUCT_MAP` / `REST_PAIR_MAP` / `CB_PAIR_MAP` module
constants with a shared loader:

```ts
// apps/api/src/market/symbolRegistry.ts
export async function loadActiveSymbols(exchange: 'kraken' | 'coinbase'): Promise<{
  ourSymbol: string; wsSymbol: string; restSymbol: string; pairId: string;
}[]>
```

backed by a join query against `trading_pairs` × `exchange_symbol_map WHERE
is_active = true`.

- **`krakenWs.ts` / `coinbaseWs.ts`**: at connect time, call
  `loadActiveSymbols()` instead of building `SYMBOL_MAP` from a literal (this
  already happens via `loadPairCache()` — extend it to also produce the
  ws-symbol maps, not just `symbolToPairId`).
- **New pair without a restart**: add a lightweight re-subscribe path —
  re-run `loadActiveSymbols()` on an interval (proposed: every 5 min, cheap
  DB query) and diff against the currently-subscribed set:
  - New symbols → send an incremental `subscribe` message for just the delta
    (both Kraken WS v2 and Coinbase Advanced Trade support subscribing to
    additional symbols on an existing connection without a full
    resubscribe/reconnect).
  - Removed symbols → send `unsubscribe` for the delta, drop from the
    reverse-lookup map.
  - This mirrors the watchdog-interval pattern already in `krakenWs.ts`
    (`setInterval` reconnect check) — same file, same lifecycle idioms, no
    new architecture needed.
- **`candleBackfill.ts`**: already calls `listActivePairs()` and filters by
  `CB_PAIR_MAP[p.symbol]` — swap that filter for a join against
  `exchange_symbol_map WHERE exchange = 'coinbase' AND is_active`. No
  structural change, just the source of the map.
- **`krakenRest.ts`**: not currently called by anything in the boot path per
  Gate 0 (only `krakenWs.ts`/`candleBackfill.ts`/`coinbaseRest.ts` are wired
  up) — confirm at Gate 2 whether it's dead code or has a caller I didn't
  find; if live, same `REST_PAIR_MAP` → `exchange_symbol_map` swap applies.

### 2.4 Rate-limit / connection-count concerns

- **Kraken WS v2**: no documented hard cap on channel count per connection
  as of the last time this was checked, but subscribing to `book` (25-depth)
  for hundreds of symbols on one connection multiplies inbound message
  volume linearly — the existing 30s watchdog assumes low-frequency-enough
  traffic that a stale-tick check is meaningful; at scale, message volume
  itself (not staleness) becomes the risk. **Recommend**: keep `book`
  subscriptions to a curated top-N by volume (e.g. top 20 pairs), and
  subscribe `ticker`+`trade` (lighter payloads) for the full expanded set.
  This needs a `subscription_tier` concept — flagged as an open question
  below, not resolved here.
- **Coinbase Advanced Trade WS**: docs (as of last review) impose a
  practical single-connection product-ID limit before Coinbase starts
  dropping/rate-limiting the connection; exact number needs re-verification
  at Gate 2 against current docs since these limits change. **Recommend**:
  budget for multiple Coinbase WS connections (e.g. batches of ~50 products
  per connection) rather than assuming one connection scales to "hundreds."
  `coinbaseWs.ts` currently assumes a single `ws` module-level variable —
  this needs to become an array of connections keyed by batch, a real
  refactor, not a config tweak.
- **REST backfill** (`candleBackfill.ts`): already rate-limited via
  `RATE_LIMIT_MS = 120` between requests and `MAX_RETRIES = 3` — this scales
  linearly with `pairs × timeframes` (currently 3 pairs × 5 timeframes = 15
  sequences; at, say, 50 pairs that's 250 sequences × up-to-several-pages
  each on every boot). **Recommend**: gate full-universe backfill behind the
  periodic refresh job (only backfill *newly added* pairs, not re-walk the
  whole universe on every boot) — `CANDLE_BACKFILL_ON_BOOT` should stay
  scoped to "pairs missing recent candle rows," not "all active pairs,
  unconditionally, every boot."
- **Open question**: does the platform want *every* Kraken∩Coinbase USD pair
  tradable (likely 100+), or a curated subset promoted from a larger
  candidate list? The rate-limit math above changes significantly between
  "20 curated pairs" and "200 pairs." This should be resolved before Gate 2
  sizing.

#### Addendum — resolved at Gate 2

- **Universe size**: resolved as curated top ~50-75 by volume (not full
  intersection), per direct instruction ahead of Gate 2 implementation.
- **Coinbase live-verification, deviating from the "budget for multiple
  connections" recommendation above**: live-fetched Coinbase's current WS
  docs (`docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/websocket/
  websocket-rate-limits`) before implementing. The only documented limits
  are **connection-rate (8/sec/IP) and unauthenticated-message-rate
  (8/sec/IP)** — no per-connection `product_ids` ceiling exists in the
  current docs. At ~75 pairs, one connection subscribing to the full set in
  a single message is well under both limits. `coinbaseWs.ts` was still
  restructured around a `Map<batchIndex, WebSocket>` (not a bare
  module-level `ws`) so growing past one batch later is a
  `COINBASE_WS_BATCH_SIZE` constant change, not a rewrite — but only one
  batch is created at current scale.
- **Kraken `AssetPairs.wsname` reliability, a gap this section didn't
  anticipate**: live-tested against `wss://ws.kraken.com/v2` — `wsname`
  reports `"XBT/USD"` for Bitcoin, which Kraken's WS v2 actually **rejects**
  (`"Currency pair not supported"`); only `"BTC/USD"` (already hardcoded in
  prod) is accepted. `symbolSync.ts` applies a small override table for
  known cases plus a **live subscribe/verify pass** against the real WS
  endpoint for every backfill/refresh candidate, so any other undiscovered
  legacy-code mismatch is caught (logged + excluded) rather than silently
  mismapped.
- **Candle backfill scope** (the `CANDLE_BACKFILL_ON_BOOT` recommendation
  above): implemented via a `hasRecentCandle()` recency check per
  `(pair, timeframe)` before fetching — see `candleBackfill.ts`.

---

## 3. SSE subscription scaling

### 3.1 Current state (from Gate 0)

`eventBus.ts` delivers `price.tick` / `candle.closed` to **every** handler
registered for a user, with no symbol filtering server-side — `useSSE.ts`
receives everything and the frontend implicitly ignores events for symbols
it's not displaying. At 3 symbols this is free. At 100+ symbols, every
connected user's SSE stream receives every tick for every symbol regardless
of what's on their screen — this is the actual scaling problem or item 3
exists to solve.

### 3.2 Per-connection interest set

Extend the `v1Events.ts` handler closure with a mutable filter, keyed by
connection, not by user (a user can only have one active SSE connection
reading one chart, but per-connection is the more correct scope — matches
one browser tab):

```ts
// v1Events.ts — inside the route handler, alongside `closed`
const interestSet = new Set<string>();  // pairIds this connection cares about

const handler: EventHandler = (event: AppEvent) => {
  if (closed) return;
  if ((event.type === 'price.tick' || event.type === 'candle.closed')
      && event.data.pairId
      && !interestSet.has(event.data.pairId)) {
    return; // filtered — not subscribed to this symbol
  }
  // ... existing write path
};
```

Events with no `pairId` (order/wallet/trigger/notification events — user-
scoped, not symbol-scoped) bypass the filter entirely and always deliver —
only `price.tick`/`candle.closed` (and any future symbol-scoped event type)
are gated. This keeps every non-market event working exactly as today.

### 3.3 Client-driven interest set updates

SSE is one-way, so updating `interestSet` needs a side-channel HTTP call, as
the prompt anticipates. Two mechanisms considered:

**Option A (recommended): `POST /v1/events/subscribe`, connection identified
by a per-stream token.**
- On SSE connect, the server generates a random `streamId` (e.g.
  `randomUUID()`), sends it as the first SSE frame (`event: stream.ready`,
  `data: {"streamId": "..."}`), and keeps an in-process
  `Map<streamId, {interestSet: Set<string>, handler}>` (module-level in
  `v1Events.ts`, next to the existing per-request closures).
- Frontend, on chart symbol switch, calls
  `POST /v1/events/subscribe { streamId, pairIds: [...] }` — replaces (not
  merges) the interest set for that stream, so switching charts is a single
  call, not an add+remove pair.
- `requireUser` still gates the POST; the handler additionally checks the
  `streamId` belongs to a connection owned by `req.user.id` (deny cross-user
  streamId guessing — small blast radius already since it only *narrows or
  widens which symbols you see ticks for*, not an auth bypass, but cheap to
  check).
- Cleanup: `streamId` entry removed from the map in the SSE handler's
  existing `cleanup()` function (same place `unsubscribe(handler)` already
  runs).

**Option B (rejected): encode interest set as an SSE reconnect querystring**
(close and reopen the SSE connection with `?pairIds=...` on every chart
switch). Rejected — reconnecting the whole event stream on every chart
switch throws away order/wallet/trigger event continuity and re-triggers the
15s heartbeat/ping setup cost for no reason; a chart switch should be cheap,
not a full stream teardown.

Option A matches the prompt's suggested shape and is the recommended design.

### 3.4 Composition with the Redis mirror

No conflict. The Redis mirror (`cp:events` channel, `eventBus.ts`) is purely
about **cross-instance delivery of the publish** — every instance still
receives every event system-wide via `deliverLocally()` after either a local
`publish()` or an incoming Redis message. The interest-set filter proposed
above sits **downstream** of that, inside each connection's `handler`
closure in `v1Events.ts` — it's a per-connection view filter, not a
subscription mechanism at the bus level. This means:
- No change needed to `eventBus.ts`, `publish()`, or the Redis channel
  itself.
- Every instance still receives every `price.tick`/`candle.closed` (fan-out
  cost at the bus layer is unchanged) — the win is purely at the
  **SSE-write** layer: fewer bytes written to fewer client sockets. This is
  the correct scope for this design (the prompt's ask is about SSE
  subscription scaling, not eventBus fan-out volume) but worth flagging as
  an explicit **non-goal**: if bus-level fan-out itself becomes the
  bottleneck (e.g. Redis publish volume at very high symbol×instance count),
  that's a separate future design (e.g. per-symbol Redis channels instead of
  one global `cp:events`) — not needed at the scale implied by "hundreds of
  pairs, current user load."

### 3.5 Addendum — resolved at Gate 2: selector-row prices vs. the interest set

Gate 2 implementation surfaced a gap this section didn't anticipate:
`PairSelectorRow`/`TickerItem`/`AssetTab`/`UnifiedOrderPanel` all read live
prices from `usePairPricesStore`, which today is fed by `price.tick`
**unfiltered**. Once `price.tick` is interest-set-filtered as designed
above (3.2), those components would only keep receiving ticks for whichever
one pair is the actively-open chart — every other pair's displayed price
would go stale immediately at scale.

**Resolved**: the interest-set filter stays scoped **exactly as designed
above** — only the chart's subscribed pair(s), via `subscribeBars`/
`unsubscribeBars` (section 4.2). `usePairPricesStore` entries for every
*other* pair are instead kept fresh by a new ~7s poll of `GET /pairs` in
`App.tsx`, reusing the existing `listPairs()` → `seedAndStripPairs()` →
`setPairs()` path (which already writes `last_price` into
`usePairPricesStore` on every call — `krakenWs.ts` debounce-syncs
`trading_pairs.last_price` server-side every ~1s, so the data was already
fresh, just not being re-fetched on a cadence). No new backend endpoint;
`PairSelectorRow`/`TickerItem`/`AssetTab`/`UnifiedOrderPanel` needed no
changes at all — they already read from the store this poll keeps warm.
The open chart's own pair stays fully real-time throughout, since it's
always in the interest set.

---

## 4. TradingView Charting Library datafeed adapter

### 4.1 Approval status caveat

Per the prompt: design against `lightweight-charts`' existing API surface so
the interface is swap-compatible if/when Charting Library access is
approved — do not block on TradingView's turnaround. Concretely: the
adapter methods below are pure data-fetching/subscription functions with no
Charting-Library-specific types in their signatures (`Bar`, `LibrarySymbolInfo`
etc. are Charting-Library-only types) — implement them once against a
minimal internal shape (`{ symbol, description, pairId }` for symbols,
`{ time, open, high, low, close, volume }` for bars), and write two thin
mapping layers on top: one to Charting Library's `IDatafeedChartApi` types
(when approved), one already usable by `CandlestickChart.tsx`'s existing
lightweight-charts data loading today. The bulk of the work (interest-set
plumbing, search endpoint, bars endpoint) is identical either way.

### 4.2 Method mapping

| `IDatafeedChartApi` method | Backing endpoint | Notes |
|---|---|---|
| `onReady(callback)` | static config, no network call | Report supported resolutions (`1,5,15,60,240,1D` mapping to existing `1m/5m/15m/1h/4h/1d`), `supports_search: true`, `supports_time: true` |
| `searchSymbols(userInput, exchange, symbolType, onResult)` | `GET /v1/pairs?search=<userInput>` (new query param) | See 4.3 |
| `resolveSymbol(symbolName, onResolve, onError)` | `GET /v1/pairs?search=<exact symbol>` (reuse search, exact match) or a new `GET /v1/pairs/:symbol/resolve` if exact-match-by-symbol-string is needed cheaper than a trigram scan | Returns `pair_id`, tick size (derive from `assets.decimals`), min move |
| `getBars(symbolInfo, resolution, periodParams, onResult)` | `GET /v1/pairs/:pairId/candles?timeframe=<mapped>&before=<periodParams.to>&limit=<periodParams.countBack>` | Already supports `before` cursor pagination per Gate 0 — direct fit, no new endpoint needed. Charting Library resolution strings (`"1"`, `"60"`, `"1D"`) need a translation table to `1m/1h/1d` |
| `subscribeBars(symbolInfo, resolution, onTick, listenerGuid)` | `POST /v1/events/subscribe` (item 3.3) + existing SSE `candle.closed`/`price.tick` handlers | `listenerGuid` maps 1:1 to adding `pairId` to the connection's interest set. Intra-candle ticks (`price.tick`) update the forming bar; `candle.closed` finalizes it — same live-update semantics already used for RSI/MACD/ATR per Gate 0 |
| `unsubscribeBars(listenerGuid)` | `POST /v1/events/subscribe` with the pairId removed from the set | On chart teardown / symbol switch |

### 4.3 `searchSymbols` via trigram index

```sql
-- GET /v1/pairs?search=<q>
SELECT id, symbol, is_active, last_price
FROM trading_pairs
WHERE is_active = true
  AND symbol % $1              -- pg_trgm similarity operator
ORDER BY similarity(symbol, $1) DESC
LIMIT 20;
```

`%` is `pg_trgm`'s similarity operator (uses the GIN index from item 1
automatically once `pg_trgm` is `CREATE EXTENSION`'d and
`SET pg_trgm.similarity_threshold` is tuned — default 0.3, may want higher
for short symbol strings like "BTC" to avoid noisy matches). Add as a new
optional `search` querystring param on the **existing** `GET /v1/pairs`
route (`v1Pairs.ts`) rather than a new endpoint — same response shape,
additive change.

### 4.4 lightweight-charts compatibility today

Since `CandlestickChart.tsx` already does exactly the fetch/subscribe
pattern above manually (candle fetch on mount + SSE `price.tick`/
`candle.closed` handlers wired through `useSSE.ts`), the adapter's internal
implementation can be extracted as a standalone module
(`apps/web/src/lib/datafeedAdapter.ts`) that `CandlestickChart.tsx` itself
consumes going forward — meaning this isn't throwaway pre-approval
scaffolding, it's a real refactor that also cleans up the ad hoc fetch logic
currently inline in the component. When/if Charting Library is approved, only
the outer type-mapping shim needs writing, not the adapter internals.

---

## 5. Indicator migration path

| Indicator | Current pattern | Charting Library custom study fit | Notes |
|---|---|---|---|
| EMA 20/50/200, VWAP, Bollinger | Overlay `LineSeries` | **Clean port** — Charting Library has native/pine-equivalent overlay studies; straightforward |
| RSI, MACD, ATR, CVD, Delta, Funding Rate, Open Interest, COT | Sub-panel components (8, via `usePanelCrosshairHover`) | **Mostly clean port** — Charting Library's custom study API supports separate-pane studies with its own crosshair/hover sync, replacing the hand-rolled hook | COT's self-only hover (weekly-UTC domain, can't main-sync) needs to be re-verified against how Charting Library handles non-time-aligned series — may still need a custom/non-study widget rather than a true study if Charting Library assumes uniform time alignment across panes |
| VPVR | Canvas primitive (`vpvrPrimitive.ts`, attached via `series.attachPrimitive()`) | **Needs rework** — this is a lightweight-charts-specific primitive API (`ISeriesPrimitive`); Charting Library has no equivalent for "custom drawing anchored to price axis with visible-range-based data." Closest fit is a custom study rendered as a histogram-per-price-bucket, but the visible/weekly/daily mode-switching UI shown in CLAUDE.md would need reimplementing against Charting Library's study parameter/recalculation model, not a straight port |
| Order Book Heatmap (left side) | Canvas primitive | **Needs rework** — same `ISeriesPrimitive` dependency as VPVR; Charting Library doesn't have a stock concept of "left-side price-axis heatmap." Likely needs a custom overlay/drawing-tool-adjacent approach, or may not be portable at all depending on what Charting Library's plugin API allows — flag as **highest-risk item** in this whole migration |
| Footprint | Canvas primitive, overlaid on candles | **Needs rework** — per-candle price-bucket rendering inside each candle body is not a stock Charting Library primitive; would need Charting Library's custom-renderer/plugin hooks (availability depends on license tier) |
| Key Levels, Liquidity Zones, Order Blocks, Liquidation Levels | Not deep-dived in Gate 0 (assumed overlay/primitive-based, same family as VPVR/heatmap) | **Unconfirmed — needs a Gate 2 code read** before committing to a migration plan | Flag as follow-up recon item, don't assume clean-port without checking |

**Summary**: line-series overlays (3 indicators) and most sub-panels (8
indicators) port cleanly in concept. The three canvas primitives — VPVR,
Order Book Heatmap, Footprint — are the actual migration risk, because
they're built against lightweight-charts' `ISeriesPrimitive` plugin surface,
which has no guaranteed equivalent in Charting Library (this varies by
Charting Library's plugin/custom-study capabilities, which weren't
verified here since library access isn't confirmed approved). **This is a
blocking unknown for full Charting Library migration, not just a
work-sizing question** — worth explicitly resolving (e.g. a TradingView
support question, or reading their plugin docs once access exists) before
Gate 2 commits to porting these three, since the answer could range from
"straightforward custom study" to "not supported, keep these three on
lightweight-charts permanently even after adopting Charting Library for the
main chart."

---

## 6. New finding at Gate 2: the `isRealPair` hardcoded gate

Neither Gate 0 recon nor this design doc caught a third hardcoded symbol
allowlist, separate from the `SYMBOL_MAP`/`PRODUCT_MAP`/`CB_PAIR_MAP` this
whole document is about: `apps/web/src/lib/pairs.ts` — `REAL_BASE_SYMBOLS =
["BTC", "ETH", "SOL"]`, applied via `isRealPair()` in `appStore.ts` and
twice in `TradingPage.tsx`. Its purpose was filtering out DB test-fixture
pairs (random symbols like `HEESTZ`) that leak into `is_active = true`
state in dev/prod from test/load-test runs. Left as-is, this would have
silently hidden every pair added by this workstream from the entire
frontend, regardless of how correct the backend work was.

**Fix, implemented at Gate 2**: `GET /pairs`/`GET /v1/pairs`
(`listActivePairsForDisplay()` in `pairRepo.ts`) now additionally require
an active `exchange_symbol_map` row — a leftover test-fixture pair
(inserted directly via SQL, never touching the real backfill/refresh path)
never has one, so it's excluded at the source. `REAL_BASE_SYMBOLS`/
`isRealPair` and its three call sites were deleted as dead code. Scoped
narrowly to the two display-facing routes only — `listActivePairs()`/
`listActivePairsLimited()` (used internally by `krakenWs.ts`/
`coinbaseWs.ts`/`candleBackfill.ts`/`marketMakerJob.ts`/
`krakenCandleSyncJob.ts`) keep their existing `is_active`-only semantics,
unchanged.

---

## Open questions (blocking Gate 2 sign-off)

1. **Universe size**: full Kraken∩Coinbase USD-pair intersection (likely
   100+ symbols) vs. a curated/promoted subset? Changes WS connection-count
   design in 2.4 materially.
2. **Kraken `book` (25-depth) subscription scope at scale**: subscribe for
   all active pairs, or only a top-N tier? Needed for order-flow/liquidity
   features — full-universe book subscription may be unnecessary cost if
   those features stay BTC/ETH/SOL-only for now.
3. **Coinbase WS multi-connection batching**: exact per-connection
   product-ID ceiling needs re-verification against current Coinbase docs at
   Gate 2 (rate limits/connection policies change over time; Gate 1 didn't
   re-fetch live docs, relying on general knowledge from this design
   session).
4. **Wallet/asset provisioning at scale**: `assets` + per-user `wallets`
   rows are created per traded symbol — does adding 100+ pairs mean 100+
   wallet rows per user (lazy-created on first trade, or eager at symbol
   launch)? Not investigated in Gate 0/1, needs a read of wallet
   provisioning logic before Gate 2.
5. **Charting Library plugin/custom-study capability for VPVR / heatmap /
   footprint** (section 5) — needs resolving before committing to "full
   migration" vs. "hybrid: Charting Library for standard chart + keep
   lightweight-charts primitives for these three," which is a real
   architectural fork, not a detail.
6. **`pg_trgm.similarity_threshold` tuning** for short symbols (`"BTC"`,
   `"ETH"`) — default 0.3 may over- or under-match; needs empirical tuning
   against the actual expanded symbol list once it exists, not resolvable in
   the abstract.

---

**Gate 1 deliverable complete — no implementation code written.** Awaiting
review/sign-off before Gate 2 begins.

---

## Gate 2 status: implemented (2026-07-22)

All 8 steps from the Gate 2 implementation plan landed, one commit per
step, each typechecked/tested/verified before the next: migration 071
(`exchange_symbol_map` + `pg_trgm`), symbol discovery + one-time backfill
script, periodic refresh job, feed layer refactor (`krakenWs.ts`/
`coinbaseWs.ts`/`candleBackfill.ts`), candle backfill scope fix, SSE
interest-set, trigram search + the `isRealPair` fix (section 6), and the
frontend datafeed adapter. Open questions 1 (universe size) and 2 (Kraken
book-depth subscription scope — deferred, not implemented: `book` stays
subscribed for the full curated set, not narrowed to a top-N tier) were
addressed or explicitly deferred during implementation; see the addenda in
sections 2.2.1, 2.4, 3.5, and 6 above for what changed from this design
during implementation and why. Open questions 3-6 (Coinbase batching —
resolved, see 2.4 addendum; wallet/asset provisioning — resolved, see
2.2.1; Charting Library plugin capability for VPVR/heatmap/footprint;
`pg_trgm` threshold tuning) remain as noted, out of this gate's scope.
