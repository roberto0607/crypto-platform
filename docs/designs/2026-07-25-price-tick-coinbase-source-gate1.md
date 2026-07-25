# Gate 1 Design — Repoint `price.tick` to Coinbase's Trade Stream

Status: design lock, implementing same-branch immediately after (this is a
small, well-scoped change). Builds on the Gate 0 recon in `docs/followups.md`
("Hero price / chart feels 'stale'..." entry, commits `7a2b394`/`f368347`/
`cc70b55` on `add-verify-email-page`, cherry-picked onto this branch) —
not re-derived here except where new facts surfaced during design.

## 0. Recap of the finding driving this change

Kraken's ticker channel currently publishes `price.tick` and measured
~0.17-0.26 changes/sec for BTC/USD. Coinbase's `market_trades` channel is
already connected (`coinbaseWs.ts`, feeding candles + CVD) and carries
~13× Kraken's raw BTC/USD trade volume — ~1.28 price-changes/sec if used as
the `price.tick` source instead, with no semantics change (still genuine
last-trade price) and no new subsystem. This is the strongest of the three
leads measured in the recon (vs. book-channel mid-price ~0.79/sec, or full
two-venue combination's marginal +5-27% over Coinbase-alone). This doc scopes
the swap.

## 1. Where `price.tick` is published today, and its replacement

**Current publisher**: `krakenWs.ts`'s `handleTickerMessage` (~line 145),
inside the per-symbol loop, right after `setSnapshot()`:

```ts
publish(createEvent("price.tick", {
    pairId,
    symbol: ourSymbol,
    bid,
    ask,
    last,
}));
eventsPublishedTotal.inc({ type: "price.tick" });
```

**New publisher**: `coinbaseWs.ts`'s `handleMessage`, inside the trade loop
(~line 91), right after the existing `ourSymbol`/`pairId` resolution — same
shape, same event type, same metric:

```ts
publish(createEvent("price.tick", {
    pairId,
    symbol: ourSymbol,
    bid: null,
    ask: null,
    last: price,
}));
eventsPublishedTotal.inc({ type: "price.tick" });
```

**`bid`/`ask` become `null`** — Coinbase's `market_trades` channel is a trade
print (price/size/side/time), it carries no quote data, and `coinbaseWs.ts`
isn't subscribed to a Coinbase order-book/ticker channel (only
`market_trades`). `PriceTickData.bid`/`.ask` are already typed `string |
null` (`eventTypes.ts:57-63`), so this is schema-legal, not a new nullable
case downstream has to learn about.

**Known, accepted regression**: the trade-page "FILL SPREAD" readout
(`CandlestickChart.tsx:1616-1624`) reads `snapshot.bid`/`snapshot.ask` and
already guards `if (!(ask > 0) || !(bid > 0)) return "—"` — so with
Coinbase-sourced ticks it will show `—` instead of a live spread, rather than
crashing or showing garbage. This is an intentional, scoped tradeoff: adding
Coinbase quote data back would mean subscribing to a second Coinbase channel
(`ticker` or `level2`), which is real new surface area (its own reconnect/
batch handling, a second parse path) for a display-only readout — **out of
scope for this gate, own follow-up if FILL SPREAD accuracy is missed.**

**Explicitly out of scope — `snapshotStore`**: `handleTickerMessage` also
calls `setSnapshot(ourSymbol, {...})`, a *separate* subsystem
(`market/snapshotStore.ts`) consumed by order pricing/matching
(`phase6OrderService.ts`), slippage (`slippageModel.ts`), the market-maker
bot, and match settlement — none of which is the SSE `price.tick` broadcast.
**This change does not touch `setSnapshot`/`snapshotStore` at all** — Kraken
remains the sole source for order-pricing snapshots. Conflating the two would
turn a small, reviewable change into a change that touches live order
execution, which is a different risk class entirely and not what was asked.

## 2. Clean swap vs. Kraken-as-fallback — **decision: lightweight fallback**

Checked `coinbaseWs.ts` for an existing health/staleness pattern to see if a
fallback would be cheap, per the ask. Finding: **it doesn't have one.**
Kraken's connection (`krakenWs.ts`) has an explicit app-level watchdog —
`lastTickAt` timestamp + a 10s-interval check that force-reconnects if
`Date.now() - lastTickAt > WATCHDOG_TIMEOUT_MS` (30s), catching the case
where the socket stays open but Kraken silently stops sending. Coinbase's
per-batch reconnect (`scheduleBatchReconnect`) only fires on the WS-level
`close`/`error` events — there's no equivalent "socket's open but nothing's
arriving" detector.

That's a real, concrete resiliency gap (not a hypothetical), so **a clean
swap is not the safer default here** — if Coinbase's socket ever goes silent
without closing, `price.tick` would stop entirely with nothing to catch it,
which is a worse failure mode than today (Kraken currently has no upstream
dependency to go silently stale on). Decision: **Kraken's ticker handler
keeps its `price.tick` publish call, gated to fire only when Coinbase looks
stale.**

Design, mirroring Kraken's own existing watchdog shape for consistency
(global connection-level liveness, not per-pair — same pattern Kraken already
uses for its own reconnect):

- `coinbaseWs.ts` gets a module-level `lastTradeAt` timestamp, updated on
  every trade message it processes (any pair) — exported via
  `getCoinbaseLastTradeAt(): number`.
- `krakenWs.ts`'s ticker handler publishes `price.tick` only when
  `Date.now() - getCoinbaseLastTradeAt() > COINBASE_STALE_THRESHOLD_MS`.
- **Threshold: 15s.** Coinbase's combined trade rate across all 75 pairs is
  far higher than the single-pair rates measured in the recon (BTC/USD alone
  was already ~4.2 raw msgs/sec) — 15s of zero trades across the *entire*
  curated universe is already a strong "something's actually wrong" signal,
  well short of Kraken's own 30s reconnect threshold, so the fallback engages
  promptly without false-triggering on normal per-pair quiet lulls (recon
  observed gaps up to ~18s on a *single* pair, not across all 75 at once).
- This avoids the dual-publish price-flicker problem the recon's combined-
  venue analysis flagged (persistent $1.68-$4.36 Kraken/Coinbase divergence
  on BTC/USD) — the two sources are never publishing concurrently in normal
  operation, only Kraken taking over during a genuine Coinbase outage. One
  extra import (`getCoinbaseLastTradeAt` into `krakenWs.ts` from
  `feeds/coinbaseWs.ts` — no circular dependency, `coinbaseWs.ts` doesn't
  import from `market/krakenWs.ts`), one timestamp comparison. Slightly more
  code than a clean swap, justified by the watchdog-gap finding above.

## 3. Downstream consumers — checked for Kraken-specific assumptions

- **`triggerEngine.ts`** (`triggerEngine.ts:269`) and **`alertEngine.ts`**
  (`alertEngine.ts:244`) both `subscribeGlobal` to the event bus and branch
  on `event.type === "price.tick"`, reading only `pairId` and `last` off
  `PriceTickData` — no field, comment, or code path references Kraken,
  bid/ask specifically, or assumes a particular upstream venue. **Confirmed
  venue-agnostic**, not assumed.
- **SSE delivery** (`v1Events.ts`): the per-connection interest-set filter
  (`shouldDeliverToStream`) gates purely on `event.type` +
  `event.data.pairId` — no venue awareness anywhere in the delivery path.
  **No architectural conflict** — this is a backend publisher-side change
  only; `v1Events.ts`, `datafeedAdapter.ts`, and all frontend code are
  unaffected.
- **Tests**: only one test references `price.tick`
  (`v1Events.test.ts:29-30`), constructing a generic `PriceTickData` fixture
  with no Kraken dependency — no change needed. `disableKrakenFeed: true`
  (test app-build option, `app.ts:57`) currently gates *both*
  `startKrakenFeed()` and `startCoinbaseFeed()` (pre-existing naming quirk,
  `app.ts:350-361` — unrelated to this change, not fixing it here since it
  doesn't affect test correctness, just the flag name undersells what it
  disables). No dedicated unit tests exist for `krakenWs.ts` or
  `coinbaseWs.ts` themselves.

## 4. Applies across all ~75 pairs — confirmed, not assumed

`exchange_symbol_map` already lists `coinbase,kraken` for all 75 active
pairs (queried directly against local Postgres). Live-confirmed further:
grepping the running dev server's log for `coinbaseWs.ts`'s own periodic
`"N trades ingested (latest: ...)"` line (already fires every 50 trades,
pre-existing) shows **all 75 active pairs have already produced at least one
live Coinbase trade message** during this session — not just the two pairs
(BTC/USD, XLM/USD) sampled in the recon. The trade handler doing the
publishing is the same function for every pair; there's no per-pair branch
to miss.

## 5. Summary of changes

- `coinbaseWs.ts`: add `publish(createEvent("price.tick", ...))` +
  `eventsPublishedTotal.inc(...)` in the trade loop; add `lastTradeAt`
  tracking + `getCoinbaseLastTradeAt()` export.
- `krakenWs.ts`: gate the existing `price.tick` publish call in
  `handleTickerMessage` behind the Coinbase-staleness check. `setSnapshot()`
  and `aggregateTick()` calls in both files are untouched.
- No schema change, no migration, no frontend change.
