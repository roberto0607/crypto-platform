# Follow-ups

Tracked work items that are real but not blocking the task in flight. Each
should become its own PR.

---

## Incomplete migration-059 cleanup — dead references to dropped tables

**Discovered:** 2026-05-26, while running the load-test baseline (the seed
failed; root-causing it surfaced that the harness assumed pre-059 schema).

**Context:** Migration `059_drop_exchange_tables.sql` (applied 2026-05-18)
dropped the risk/governance subsystem tables for paper-trading simplification:
`incidents`, `incident_events`, `repair_runs`, `reconciliation_reports`,
`account_limits`, `circuit_breakers`, `risk_limits`, `user_quotas`.

The table drops landed, but **live `src/` code still references them**, so the
removal is half-done. These are latent bugs:

- **`apps/api/src/routes/healthRoutes.ts:92`** — runs `... FROM circuit_breakers`
  (dropped). The endpoint likely 500s when that branch executes. *(Workaround in
  the meantime: use `GET /pairs` as the API-up probe for load tests, not
  `/health`.)*
- **`apps/api/src/outbox/outboxProcessor.ts:47`** — calls
  `openIncidentsForQuarantinedUsers(reconRunId, userIds)`, which writes to the
  dropped `incidents` table. Gated behind the reconciliation job, so it does not
  fire under `DISABLE_JOB_RUNNER=true` and may be dormant in prod too — but it
  will throw if ever reached.
- **`apps/api/src/incidents/` module** (`incidentService.ts`, `incidentRepo.ts`,
  `incidentTypes.ts`, `proofPackService.ts`) and **`apps/api/src/routes/v1/v1Incidents.ts`**
  — an entire feature surface still targeting dropped tables.
- Also referencing the removed subsystem: `security/suspiciousActivityService.ts`,
  `scripts/risk-smoke.sh`, `scripts/repair-smoke.sh`. (`metrics.ts` only defines
  in-memory `incidents_*` counters — harmless, no DB access.)

**Scope of fix:** decide per reference whether to delete (subsystem is gone) or
re-point. Most likely a clean deletion of the incidents module + route +
healthRoutes query + outboxProcessor quarantine path. Needs a careful pass so
nothing else imports the removed code.

**Priority:** not blocking load testing (order placement does not gate on any
dropped table). Should be its own PR after the load-test work lands.

**Not blocking because:** verified the order-placement path
(`phase6OrderService`, `tradingRoutes.ts`, queue) has no `account_limits` /
`circuit_breakers` dependency.

---

## ✅ RESOLVED (PR #30, verified in prod) — Redis order queue bricks per-pair after 100 lifetime orders (XLEN depth bug)

**Resolved 2026-05-26:** XDEL-after-XACK so XLEN tracks live depth (PR #30, merged
`390d615`). Verified in prod (order 201, depth=0, `pair_queue_xdel_failures_total`=0).
Original investigation trail below. (Caveat: the boot-flush "safety net" referenced
below turned out to be a no-op — see the `flushStaleStreams` follow-up.)


**Discovered:** 2026-05-26, load-test baseline (Redis pass). All write-heavy
scenarios failed on `pair_queue_overloaded` (HTTP 503) — 84.5% (trade_burst),
28.9% (mixed), 94.8% (outbox). In-memory pass: 0% errors on the same scenarios.

**Root cause:** the per-pair depth guard reads the **total** stream length and
compares to `config.maxQueueDepth` (default 100):

```
apps/api/src/queue/redisQueue.ts:202   const depth = await redis.xlen(key);
apps/api/src/queue/redisQueue.ts:203   if (depth >= config.maxQueueDepth) throw pair_queue_overloaded
```

But the consumer **`XACK`s without `XDEL`/`XTRIM`**:

```
apps/api/src/queue/redisQueue.ts:432   await redis.xack(streamKey(pairId), GROUP_NAME, msgId);
                                       // no XDEL / XTRIM — entry stays in the stream
```

`XACK` only clears the pending-entries list; it does **not** remove the entry
from the stream. So `XLEN` counts every order ever `XADD`ed and never shrinks.
After 100 orders land on a pair's stream (since the last restart), `xlen` stays
≥100 and **every subsequent order 503s — permanently** — even though the
consumer is fully caught up. Verified live: `XLEN=100`, consumer group
`pending=0, lag=0`.

The only thing that clears it is the **startup flush** (`redisQueue.ts:109-125`,
`XTRIM MAXLEN 0` on boot), so a server restart temporarily "fixes" it.

**Why it's invisible today:** tiny user load (never 100 orders/pair per uptime
window) + frequent Railway deploys (each restart flushes). Under sustained real
load it bricks each pair after 100 lifetime orders. The in-memory queue does not
have this bug — it checks `pq.jobs.length` (`queueManager.ts:77`), which shrinks
as jobs drain.

**Fix options (own PR):**
- (a) `XDEL` the message (or periodic `XTRIM`) after `XACK` so the stream tracks
  live depth; or
- (b) base the guard on pending/lag (`XPENDING` / consumer-group `lag`) instead
  of `XLEN`; or
- (c) `XADD ... MAXLEN ~ N` to cap the stream on write.
  Option (b) most directly matches the in-memory semantics (`jobs.length` =
  unprocessed work).

**Caveat / Phase 2B:** the baseline ran all load on a single pair (one consumer).
Confirm against multi-pair load to separate this XLEN bug from any
single-consumer throughput ceiling.

**Priority:** high — this is the headline scaling blocker from the baseline run.

---

## ✅ RESOLVED (PR #31) — trade_burst order placement p95 ~3× slower than March (candles seq scan)

**Resolved 2026-05-27** by pinning the sim candle lookup to `timeframe='1m'` (PR #31,
merged `e7cda6a`, deployed). Local Redis trade_burst p95 **254ms → 60ms** (0% errors);
prod candle query **133ms → 0.108ms** (EXPLAIN). New floor recorded in slo-baseline.md.
Original investigation trail kept below.


**Discovered:** 2026-05-26 baseline (in-memory pass — same backend as March, so a
true regression). **Diagnosed:** 2026-05-27. Root cause + fix in
[docs/designs/2026-05-27-candles-query-index.md](designs/2026-05-27-candles-query-index.md).

| order_placement_ms p95 (in-mem) | value |
|---|---|
| March 3 (`35aa84a`) | 72ms |
| 2026-05-26 (`1eb5fb3`) | 201ms |
| 2026-05-27 (`fe8433a`, ×2) | 253–254ms |

Worsening over time, 0% errors, now grazing the 250ms SLO.

**~~Original hypothesis: PR #26's `getActiveMatchIdForUser` lookup at the HTTP edge
(`tradingRoutes.ts:196`) is a new, possibly-unindexed per-order query on `matches`.~~
— INVESTIGATED, REFUTED (2026-05-27).** `EXPLAIN ANALYZE`: that query is **0.016ms,
fully indexed** (`idx_matches_challenger`, `idx_matches_opponent`, partial status
indexes all exist). Wrong table — not the cause.

**Actual root cause:** the per-MARKET-order candles lookup in `phase6OrderService` —
`SELECT volume,high,low FROM candles WHERE pair_id=$1 AND ts<=$2 ORDER BY ts DESC LIMIT 1`
— omits `timeframe`, so neither `(pair_id,timeframe,ts)` index can seek. `EXPLAIN`:
**Parallel Seq Scan of ~211k candles + sort = 18.9ms**, the bulk of the ~25ms per-order
exec. The query is **byte-identical to March** — it's *data growth* (the startup
backfill keeps adding candles), so the same scan got slower and worsens each restart.
Under trade_burst's single-pair 10-VU load the in-memory queue serializes orders, so
~25ms/order × pile-up = the ~254ms p95 tail (median stays ~60ms).

Confirmed via a **1-VU control run**: p95 collapsed to ~55ms with `pair_queue_wait_ms`≈0
→ the tail is serialization amplifying per-order exec, not per-order cost alone.

**Fix:** pin `timeframe='1m'` → index seek, **18.9ms → 0.30ms**. Expected: per-order
exec ~25ms→~6ms; trade_burst 10-VU p95 ~254ms→~72ms. Full design + test/migration/PR-story
in the design doc above.

**Scope:** own PR, separate from the XLEN queue fix. **Priority:** medium — now
actionable (one-line query change + integration test).

---

## 🟠 `flushStaleStreams` boot flush is a no-op — SCAN MATCH lacks the `cp:` keyPrefix

**Discovered:** 2026-05-27, verifying the candles fix (a local Redis stream stuck at
XLEN=100 from pre-XLEN-fix testing was NOT cleared on API restart).

`flushStaleStreams` (`redisQueue.ts:~114`) scans with `redis.scan(cursor, "MATCH", "queue:*", ...)`,
but ioredis's `keyPrefix: "cp:"` is **not** applied to the SCAN MATCH pattern — the real
keys are `cp:queue:*`. Verified: `SCAN MATCH 'queue:*'` → 0 keys; `MATCH 'cp:queue:*'` → 2.
So the boot-time flush has **never** matched the real streams; it's a no-op.

**Corrects the XLEN PR design doc** (`docs/designs/2026-05-26-xlen-queue-bug.md`), which
claimed "the boot flush resets every stream to 0 on the first deploy." It does not — a
stream stuck ≥`maxQueueDepth` pre-fix would stay stuck after a restart.

**Prod impact: low / latent.** Prod's tiny lifetime order-count keeps streams well under
100, and the XDEL fix now self-drains them, so this isn't biting prod. But it's wrong and
the safety net it was meant to provide doesn't exist.

**Fix:** use `rawStreamKey`-style fully-qualified pattern (`cp:queue:*`) in the SCAN, or
strip/re-add the prefix. Add a test (the existing redis integration harness can assert a
seeded `cp:queue:*` stream is flushed on init). **Priority:** medium.

---

## 🟠 Prod per-order exec ≈ 190ms (order pipeline, not the candle query)

**Discovered:** 2026-05-27, post-candles-fix prod verification. Demo MARKET orders return
201/FILLED in sub-second round-trip, but `pair_queue_exec_ms` ≈ 190ms/order. The candle
query is now 0.108ms (EXPLAIN), so the residual is the rest of the order pipeline —
matching engine, ledger writes, snapshot, and prod DB round-trip latency over larger
prod tables (orders/trades/ledger/positions). Local exec is ~8ms by comparison.

Not caused by (and not blocking) the candles fix — the fix removed ~133ms/order in prod.
But ~190ms server-side per order is the next thing between "feels instant" locally and in
prod. **Next diagnostic:** instrument/time the phases inside `placeOrderTx` (match vs
ledger vs snapshot) against prod, or capture per-statement timings. **Priority:** medium —
sub-second today, but it's the new ceiling on order latency. (Probably needs its own
investigation, like the trade_burst one.)

---

## 🟢 Phase 2B — multi-pair load scenario (unblocked)

Now that the XLEN bug (PR #30) and the candles seq scan (PR #31) are fixed, the load
harness can finally measure *real* scaling — the single-pair baseline kept hitting a
false ceiling. Build a multi-pair (BTC+ETH+SOL) write scenario + ramp/stress executors
to find actual limits, and exercise cross-pair concurrency (PR #28's per-consumer Redis
connection model) and in-match order flow (PR #26 edge path) under load — none of which
the single-pair baseline covered. See `docs/designs/2026-05-26-xlen-queue-bug.md` §e.
**Priority:** the next scaling step (feature-vs-fix call is yours).

---

## 🔴 HIGH — Market-maker bot not quoting in prod → LIMIT orders never fill in solo play

**Discovered:** 2026-05-27, investigating order visibility/fills (see
`docs/designs/2026-05-27-open-orders-panel.md`). This is the **gating issue** that
makes resting LIMIT orders functionally useless for a solo user in prod.

**Evidence (prod, grounded from Postgres):**
- During a manual test window (2026-05-27 20:30–21:10 UTC) the **only** BTC/USD orders
  were the user's own. The bot (`config.botUserId` = `00000000-…-0001`) placed **zero**
  orders.
- The **entire current BTC/USD resting book** is just the user's stuck LIMIT BUYs —
  no asks, no other bids, no bot liquidity at all.
- All of the user's MARKET fills are `is_system_fill = true` — they filled via the
  matching engine's system fallback at `pair.last_price`
  (`matchingEngine.ts:184-191`), **not** against any resting book.

**Why LIMIT orders never fill (and it's NOT a matching bug):**
- LIMIT orders have **no system-fill fallback** (by design — that would defeat the
  limit price). A resting LIMIT only fills when a counterparty *crosses* it.
- With no bot quoting and self-trade prevention (`orderRepo.ts` `excludeUserId`,
  tested at `tests/trading.test.ts:505`) blocking the user's own market sells from
  hitting their own bids, **nothing ever crosses a solo user's resting limit.**
- MARKET orders still work (system fallback). LIMIT orders silently rest forever.

**Open questions for the investigation (diagnose-then-fix, like candles/XLEN):**
1. Is `DISABLE_MARKET_MAKER` set in the Railway API service env? (config default is
   `false` — `config.ts:133`.) Cheapest possible cause.
2. Is the `marketMakerJob` actually registered + running? Is `DISABLE_JOB_RUNNER`
   set in prod? Is the bot user (`00000000-…-0001`) present and its wallets funded?
3. **Behavioral correctness even if the bot runs:** the bot posts passive LIMIT
   bids/asks via `placeOrderWithSnapshot` (`marketMakerJob.ts`). When the bot
   re-quotes and its new ask drops *below* a user's resting bid (or new bid rises
   above a user's resting ask), does the bot's incoming order cross & fill the user's
   resting limit at the maker price? This is the path that would make limit orders
   actually fill. Verify it works, with a discriminator test.

**Priority:** HIGH. Next investigation after the open-orders-panel UI work (PR A)
clears. Acceptance criterion #6 ("LIMIT BUY fills at limit price or lower") is *coded*
correctly (`matchingEngine.ts:166`, tested at `matchingEngine.test.ts:283`) but is
**unexercisable in solo prod** until this is fixed.

**Not blocking PR A:** the open-orders panel + cancel UI is about *visibility and
control* of resting orders, which is valuable regardless of whether they fill.

---

## 🔵 LOW — Orders enum casing inconsistency in `tradingRoutes.ts` schema

**Discovered:** 2026-05-27, during PR A casing verification (commit `b943ce1`).

**Where:** `apps/api/src/routes/tradingRoutes.ts:130` declares the orders status
field's JSON-schema enum as `["OPEN", "FILLED", "PARTIALLY_FILLED", "CANCELLED"]`
— `"CANCELLED"` with **two L's**.

**Source of truth disagrees:** the `orders_status_check` constraint in
`apps/api/migrations/007_orders_trades.sql:20` uses `"CANCELED"` (one L), and
`apps/api/src/trading/matchingEngine.ts:549` emits `setOrderStatus(client,
orderId, "CANCELED")`. The frontend was fixed to match the backend in PR A
(`b943ce1`) — but this route's JSON schema still drifts.

**Why harmless today:** the dock queries `status=OPEN`, and the JSON schema is
used for Fastify request validation / OpenAPI docs — not to construct WHERE
clauses or status emissions. So nothing actually filters or serializes through
the wrong-cased member today. But if anyone wires a `?status=CANCELED` filter
through this route, validation will reject it; and any TypeScript client
generated from the schema will get the wrong literal type for canceled orders,
diverging from the DB values.

**Fix:** change `"CANCELLED"` → `"CANCELED"` in the
`apps/api/src/routes/tradingRoutes.ts:130` enum, run `pnpm typecheck`, ship.
One-line change.

**Priority:** LOW — backend cleanup, no user-visible impact.


