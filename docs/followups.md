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

## ✅ RESOLVED (PR B) — Market-maker bot not quoting in prod → LIMIT orders never fill in solo play

**Resolved 2026-05-29:** bot row unwedged via targeted UPDATE on 2026-05-30
00:24:25 UTC; durable fix shipped in PR B (this PR). See
[docs/designs/2026-05-29-job-runner-stale-running-recovery.md](designs/2026-05-29-job-runner-stale-running-recovery.md).
Original investigation trail kept below — note both "open question" hypotheses
(#1 config disable; #2 missing registration / bot user / wallets) turned out
**wrong**. The actual cause was a stale `last_status='RUNNING'` row in `job_runs`
(market-maker, wedged 2026-03-30) that `findDueJobs` excluded on every tick
forever; env was clean, the job was registered, and the bot user/wallets existed.
Post-deploy prod verification of the auto-recovery is tracked as its own entry below.


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

---

## 🟠 MEDIUM — Post-deploy verification — PR B (job-runner stale-RUNNING recovery)

**ONE-TIME task, run on the next deploy of PR B.** Confirms the durable fix
actually recovers a wedged job under the real deploy-kill trigger. The manual
unwedge on 2026-05-30 proved the bot *works*; it did **not** prove the automatic
recovery (`resetStaleRunningOnStartup` + the `findDueJobs` stale-RUNNING arm)
fires on a real Railway restart. Until this is checked, the fix is verified only
by local integration tests. Source: §e of
[docs/designs/2026-05-29-job-runner-stale-running-recovery.md](designs/2026-05-29-job-runner-stale-running-recovery.md).

1. **Steady-state log check.** Tail `crypto-platform` logs on Railway across a
   deploy. Expect each boot to log `Job runner startup: reset N stale RUNNING
   rows`. `N=0` = healthy steady state (nothing wedged); `N>0` = a row was wedged
   before this boot and is now recovered.
2. **Deploy-kill recovery (the actual repro).** Restart the `crypto-platform`
   service via Railway's restart button during the first ~0–10s of a market-maker
   quoting cycle (mid-tick). Confirm:
   - next boot logs `Job runner startup: reset 1 stale RUNNING row (was running before this boot)`;
   - market-maker resumes quoting within ~one tick (~10s);
   - the `job_runs` row for `market-maker` flips `RUNNING → FAILED → RUNNING → SUCCESS` within ~30s of the restart.
3. **End-to-end fill.** As `rtirado0607@gmail.com`, place a marketable LIMIT BUY
   in prod and confirm it fills against a bot ask with `is_system_fill = false` —
   same end-to-end verification as 2026-05-29 night.

Once verified, mark this entry RESOLVED and link the verification record.
**Priority:** MEDIUM — preventative verification, not corrective; time-sensitivity
(run on the next PR B deploy) is captured above. HIGH is reserved for things
actively broken in prod, which this is not.

---

## 🔵 LOW — `pg_try_advisory_lock` without explicit `pg_advisory_unlock` in `runJob`

**Discovered:** 2026-05-29 during PR B review (by Claude Code); deliberately
deferred to keep PR B scoped to the stale-RUNNING fix.

**Where:** `apps/api/src/jobs/jobRunner.ts` — `runJob`.

**Behavior:** `runJob` acquires a per-job lock via
`pg_try_advisory_lock(hashtext($1))` but never explicitly releases it with
`pg_advisory_unlock`. The lock is *session*-scoped, so it rides the pooled
connection — `client.release()` returns the connection to the pool **without**
releasing the lock or resetting session state.

**Risk:** the lock for job A persists on connection C1 after its run. If A's next
run draws a different connection C2 from the pool, `pg_try_advisory_lock` for A on
C2 still succeeds — but if C2 is the one still holding A's lock from a prior run,
a concurrent attempt elsewhere would see false-positive lock contention and skip.
More generally, stale session-held locks accumulate across the pool and can cause
spurious `runJob` skips. PR B's new "claimed by another worker" early-return shares
the same `finally { client.release() }` as the existing lock-contention return, so
it's consistent with current behavior — but neither path unlocks.

**Likelihood today: low in practice, but not provably safe.** Single API instance,
jobs already serialized by the advisory lock, and frequent Railway restarts clear
all session state — so it isn't biting today. But node-postgres' `Pool` does **not**
run `DISCARD ALL` or release advisory locks on `client.release()` by default
(contrary to a common assumption), so a reused connection genuinely can retain a
stale lock. Whether that ever produces a wrong skip depends on pool size and
connection-reuse timing — murky enough to warrant its own investigation rather than
a confident "safe."

**Fix:** pair the acquisition with an explicit `pg_advisory_unlock(hashtext($1))`
in `runJob`'s `finally` — but **only on the path where the lock was actually
acquired** (the lock-contention early-return must not unlock a lock it never took).
Ship with a discriminator test: run two `runJob` invocations back-to-back forcing
the same pooled connection, and confirm the second does not see a stale lock.

**Priority:** LOW — backend hardening, no observed user-visible impact.

---

## ✅ RESOLVED (PR #35) — `/health` 429s during multi-tab cold load → full-page SERVER OFFLINE wall

**Resolved 2026-06-01** by PR #35 (commit `b291dd0`). Client now discriminates
429 (rate-limited → silent retry, honoring `Retry-After`) from genuine
unreachability, and `/health` gets a dedicated **120/min** per-route bucket
independent of the global 100/min-per-IP limit. Verified in prod 2026-06-01
12:00 AM: opening 8–10 tabs in rapid succession no longer renders the full-page
wall. Original investigation trail below.

**Discovered:** 2026-05-31 ~10:19 PM, opening 4 Safari tabs of
`https://gallant-reprieve-production.up.railway.app/trade` in rapid succession
produced the full-page **"SERVER OFFLINE — Cannot reach the backend API"** wall
on at least one tab. Web Inspector confirmed at 10:26 PM:
`Failed to load resource: the server responded with a status of 429 () https://crypto-platform-production-691d.up.railway.app/health`.

**Root cause — two cooperating bugs:**
- **Server:** `/health` was rate-limited from the shared global 100/min-per-IP
  bucket, which gets starved by multi-endpoint cold-load traffic.
- **Client:** treated a 429 on `/health` as "server offline" rather than "rate
  limited, retry later," so a transient throttle rendered the full-page wall.

**Fix:** client `checkHealthWithRetry` (`apps/web/src/lib/healthCheck.ts`)
discriminates failure modes (429 → silent retry; 5xx → offline immediately;
network errors → backoff, offline only after 3 consecutive failures); server
gives `/health` a dedicated 120/min per-route bucket
(`apps/api/src/routes/healthRoutes.ts`).

---

## 🟠 MEDIUM — Other endpoints starve the global rate-limit bucket under multi-tab load (follow-on from PR #35)

**Discovered:** 2026-06-01 ~12:01 AM, during post-merge stress-test of the
`/health` 429 fix (PR #35).

After PR #35 landed, the full-page SERVER OFFLINE wall no longer renders on
multi-tab cold load. But stress-testing with **8–10 tabs opened in rapid
succession from one IP** (verified 2026-06-01 12:00–12:01 AM) still produces
degraded states:

- Some tabs show the green **MARKETS LIVE** badge but **"NO PAIRS AVAILABLE"** in
  the trading view (i.e. `GET /api/pairs` was 429'd or returned empty).
- Some tabs show the **OFFLINE** badge with a **REFRESH** button (i.e. SSE failed
  to establish and didn't recover within ~60s).

**Root cause — same shape as PR #35:** the shared global 100/min-per-IP bucket
gets starved when ~5+ tabs cold-load simultaneously and each fires ~6 endpoint
calls (`/api/status`, `/api/pairs`, `/api/assets`, `/api/wallets`, etc.) within a
few seconds — 30–60 requests against the 100/min budget. Once depleted,
individual endpoints get 429'd; the UI gracefully degrades but data is missing.

**Fix options to evaluate (rough preference order):**
- **(c)** Tiered: give the 4–6 cold-load-critical endpoints their own per-route
  buckets like we did for `/health`, keep global 100/min for everything else
  (matches the pattern just established; principled).
- **(a)** Give each implicated endpoint its own dedicated bucket (more granular,
  more config).
- **(b)** Loosen the global limit to 200–300/min (simplest; lower abuse ceiling).

**Nested frontend bug:** the **"NO PAIRS AVAILABLE"** message is misleading when
`/api/pairs` returns 429 — it implies a permanent state when it's transient. The
frontend should show "loading…" / "retrying…" in that case. Separate, smaller
frontend fix.

**Realistic-user impact:** limited (1–3 tabs is normal usage; this only trips at
5+). But stress-testing reveals it, and if TRADR were ever shown to multiple
devices at once (interview demo, multi-monitor user), it would degrade visibly.
Worth fixing before any high-stakes demo where ≥3 simultaneous clients on one IP
is possible. **Priority:** MEDIUM.

---

## 🔵 LOW — Dev seed candle-count check is timeframe-agnostic

**Discovered:** 2026-06-03, during PR #38 dev verification — the BTC asset chip
showed a price but no 24h-change %, traced to an empty `1d` candle response.

**Where:** `apps/api/scripts/seed-dev-user.ts:88`.

**Behavior:** the "should I backfill candles?" check runs `SELECT COUNT(*) FROM
candles WHERE pair_id = $1` with no timeframe filter. If the dev DB already
holds ≥100 candles of *any* timeframe (e.g. `1m`/`1h` from a running live Kraken
feed), the seed treats candles as "sufficient" and skips the backfill — so `1d`
coverage can be absent even though the table looks full. That silently breaks
the 24h-change feature in dev (daily-open fetch returns empty → chip shows no
change).

**Fix:** make the check `timeframe = '1d'`-specific, or have the seed always
ensure `1d` coverage regardless of other-timeframe counts.

**Priority:** LOW — dev-tooling only, no prod or user impact. Source: PR #38
(decouple-live-prices, 2026-06-03).

---

## 🔵 LOW — `usePairChange` first-render artifact (cold-load blank-chip window)

**Discovered:** 2026-06-03, during PR #38 dev verification (initially misread as
a data gap; confirmed to be a pre-settle render artifact).

**Where:** `apps/web/src/hooks/usePairChange.ts` + `dailyOpenStore`.

**Behavior:** `usePairChange` returns `null` for the ~100–500ms window between
mount and the first `/candles` response settling, so the asset chip shows a
price but no change % during that window — a brief "no change" flash on every
hard refresh. Pre-existing cold-load latency, not a regression.

**Fix:** persist `dailyOpenStore` to localStorage so the prior session's open
survives reloads; on mount, hydrate from localStorage (subject to a `dateUTC`
freshness check) before the network fetch settles, then let the fetch
refresh/correct.

**Priority:** LOW — cosmetic, sub-second, no data-correctness impact. Source:
PR #38 (decouple-live-prices, 2026-06-03).

---

## 🟠 MEDIUM — API in-memory pair-list cache goes stale after a DB reseed

**Discovered:** 2026-06-03, during PR #38 dev verification — surfaced as a
"frozen prices" scare (the UI stopped ticking with no console error) and cost
~30 min of diagnosis before being traced to a stale-UUID mismatch.

**Context:** the API reads the pair list at startup and caches it in memory.
After a dev reseed (which can regenerate pair UUIDs), the running API keeps
emitting SSE price events keyed by the *old* UUIDs, while `/api/pairs` returns
the *new* ones. Frontend components subscribe to the new UUIDs but receive SSE
writes for the old ones — they never match, and the page freezes silently. The
restart-required workaround was non-obvious; the 30-min diagnosis is concrete
evidence it recurs on every reseed-without-restart, and the stale-cache shape is
a latent correctness risk anywhere the pair set changes under a live API.

**Scope of fix:** re-read the pair list rather than caching it for the process
lifetime. Three options:
- **Periodic refresh** (e.g. re-read every 60s) — simplest.
- **Postgres `LISTEN/NOTIFY`** on `trading_pairs` changes — most correct
  (event-driven, no polling lag).
- **`SIGHUP`** handler for explicit refresh — cheapest manual escape hatch.

**Priority:** MEDIUM — dev-environment friction today (cost real time, will
recur), but latent risk if pairs ever change under a live prod API. HIGH is
reserved for things actively broken in prod, which this is not. Source: PR #38
(decouple-live-prices, 2026-06-03).



---

## 🟠 MEDIUM — Two tier systems share `user_tiers.tier` with incompatible vocabularies

**Discovered:** 2026-06-16, root-causing the forfeit 500 fixed by migration 069
(`user_tiers_tier_check`). Surfaced while widening that constraint.

**Context:** `user_tiers.tier` is written by **two independent tier systems that
use different, non-overlapping vocabularies**:

- **Trade Wars 1v1 ELO** — `apps/api/src/competitions/eloService.ts` (`TW_TIERS`):
  `ROOKIE, PRO, ELITE, LEGEND`. Written by `updateUserTierTx` on match
  promotion/demotion (`resolveMatchElo`).
- **Weekly competitions** — `apps/api/src/competitions/tierRepo.ts` +
  `jobs/definitions/weeklyCompetitionJob.ts` (`competitionTypes.TIERS`):
  `ROOKIE, TRADER, SPECIALIST, EXPERT, MASTER, LEGEND`. Written by
  `updateUserTier` (`WEEKLY_PROMOTION`/`WEEKLY_DEMOTION`).

Both upsert the **same** `user_tiers` row for a user. Migration 069 had to set
`user_tiers_tier_check` to the **union** of both vocabularies precisely because
either-system-only would 500 the other.

**Concrete failure mode (latent, not yet biting):** the vocabularies collide on
read. If the TW system writes `tier='PRO'` and then the weekly job reads it via
`getUserTier` (typed `TierName`) and calls `tierUp`/`tierDown`
(`weeklyUtils.ts`), those index `TIER_ORDER` by `'PRO'` — which is **undefined**
in the 6-tier order map → `idx` is `undefined`, so `tierUp` returns
`TIERS[undefined + 1]` = `TIERS[NaN]` = `undefined`, i.e. a wrong/no-op neighbor
and a corrupted tier transition. Symmetrically, TW's `getUserTierTx` maps any
non-TW value (e.g. `'MASTER'`) to `ROOKIE` via `isTWTier(...) ? ... : "ROOKIE"`,
silently resetting a weekly-earned tier to ROOKIE for matchmaking/capital.

**Why it isn't biting today:** prod `user_tiers` holds only `ROOKIE` rows — no
promotion from *either* system has persisted yet (TW's was 500ing; weekly hasn't
promoted anyone under current load). The moment both systems promote the same
user, the reads above misbehave.

**Needs a decision (own PR):** pick one of —
- **Separate the columns** — e.g. `user_tiers.tw_tier` vs `competition_tier`, each
  with its own constraint; each system reads/writes its own.
- **Namespace the values** — prefix (`TW_PRO`, `WK_MASTER`) so reads can't
  cross-interpret; both systems learn their own namespace.
- **Pick one system per user** — declare a single canonical tier and have the
  other system derive/ignore.

`competitions_tier_check` is intentionally **left at the 6-tier list** (it backs
60 legitimate weekly rows) — do not "align" it to the 4-tier TW set.

**Priority:** MEDIUM — latent correctness bug, no current user impact (gated by
the ROOKIE-only state above), but it will surface as soon as cross-system
promotions occur. Not blocking the forfeit-500 fix.

---

## 🔵 EXPLORATORY — Hero price / chart feels "stale" vs TradingView's continuous tick feel (Gate 0 recon, 2026-07-25)

**Discovered:** 2026-07-25, dedicated Gate 0 recon requested ahead of Gate 2
(multi-asset datafeed) work — checking whether the trade page's hero price and
active candle genuinely lag TradingView's feel because of a bug, or because of
a real data-source ceiling.

**Findings — data source confirmed correct, no bug found:**

- Hero price (`CandlestickChart.tsx:434-436`) reads `useTradingStore(s =>
  s.snapshot)`, written only by `onPriceTick` in `useSSE.ts:61-70`, gated to
  `d.pairId === selectedPairId`. Server-side, `GET /v1/events`'s per-connection
  interest set (`v1Events.ts`) only delivers `price.tick`/`candle.closed` for
  the pairId `datafeedAdapter.ts`'s `subscribeBars()` explicitly registered via
  `POST /v1/events/subscribe` — replaced wholesale to exactly `[pairId]` on
  every pair switch. The 7s `GET /pairs` poll (`App.tsx:183-193`) is scoped to
  the *non-active* selector-row pairs only, by design (Gate 1's interest-set
  split). **The hero price is genuinely on the real-time path, not the poll.**
- No render-path throttle: `snapshot` gets a brand-new object on every single
  tick (no batching), so every SSE tick triggers a hero-price re-render. The
  only 1s heartbeat in the file drives the O/H/L/C toolbar readout only, not
  the hero price. The live candle series (`seriesRef.current.update()`)
  updates on every tick, unthrottled. Formatting is cent-precision
  (`minimumFractionDigits: 2`), not whole-dollar rounding.
- **Live-measured tick rate for BTC/USD** (throwaway account, `/trade`, 60-66s
  windows against the running dev server + live Kraken feed):
  - Client-received SSE `price.tick` events: 16 over 66.15s ≈ **0.24/sec**
    (~1 update every 4.1s).
  - Cross-checked via temporary instrumentation of `krakenWs.ts`'s
    `handleTickerMessage`/`handleTradeMessage` (added, measured, reverted —
    clean `git diff`): ticker channel 27 msgs/163s ≈ 0.17/sec; raw
    trade-execution channel (Kraken's fastest available channel) 42 msgs/163s
    ≈ 0.26/sec. Trades arrive in **tight bursts** (multiple fills within the
    same ms — one order sweeping several book levels) separated by **silent
    gaps up to ~18s**.
  - System-wide cross-check via `events_published_total{type="price.tick"}`:
    ~1.3/sec across all ~75 tracked pairs — same ballpark as the ~1.7/sec
    figure from the price-alerts investigation; BTC/USD is ~18% of that,
    consistent with being the most liquid single pair tracked.
  - `krakenWs.ts:85-90` already subscribes to all three of Kraken's real-time
    channels (`ticker`, `trade`, `book`) — there is no unsubscribed faster
    channel to switch to for last-trade data. `price.tick` is currently
    published only from `handleTickerMessage`; the `trade` channel's data
    feeds candle aggregation and the CVD/pressure aggregator but not
    `price.tick`.

**Conclusion:** not a wiring bug, not a render throttle. The sparse, bursty
feel is Kraken's actual BTC/USD trade cadence on this single venue — a real
ceiling, not a defect.

**Update 2026-07-25 — book channel measured:** followed up same-day. Kraken's
`book` channel (25-depth, `handleBookMessage` in `krakenWs.ts`) was
temporarily instrumented (same pattern — added, measured, reverted; clean
`git diff` confirmed after) to log a timestamp + computed top-of-book mid-price
`(bestBid + bestAsk) / 2` on every snapshot/update message for BTC/USD, over a
92.9s window against the live feed:

- **Raw message frequency: 1,215 messages / 92.9s ≈ 13.1/sec** — roughly
  50-75× the ticker (0.17/sec) or trade (0.26/sec) rate. The book channel is
  genuinely far chattier, as expected (order adds/cancels vastly outnumber
  fills).
- **But 94.0% of those messages (1,141/1,215) don't move the top-of-book mid**
  — they're depth-level noise further down the 25-level book that never
  touches best bid/ask. Only **73 messages (6.0%) actually changed the mid**.
- **Mid-price-change rate: 73 changes / 92.9s ≈ 0.79/sec** (~1 change every
  1.27s on average) — a real **~3-4× improvement** over the current
  ticker-driven `price.tick` rate (0.17-0.26/sec), but nowhere near
  "continuous." The changes are **also bursty**: median gap between mid
  changes is 2ms (rapid-fire clusters, e.g. bid/ask flipping during active
  churn) but the max gap was still **16.9s** — the book goes quiet during the
  same low-liquidity lulls the trade channel does, just recovers with more
  resolution once it moves.

**Conclusion / recommendation:** deriving `price.tick` (or a separate
live-mid-price signal) from book mid-price is a **real but modest** lead —
~3-4× more update frequency, not the order-of-magnitude jump that would
actually deliver a TradingView-like continuous feel, and it would still show
multi-second silent gaps during quiet periods since those are a genuine
liquidity property of Kraken-solo BTC/USD, not an artifact of which channel is
read. It would also change semantics from "last traded price" to "best-quote
midpoint" (not an executed price — a real design tradeoff to reason through,
not just a plumbing change), and implementing it cleanly requires filtering
the 94%-of-messages noise down to mid-change events only (the naive "recompute
on every book message" approach would be ~50-75× more compute for a price
value that's unchanged 94% of the time). **Worth a small, scoped prototype if
chart-feel polish is prioritized, but not worth interrupting Gate 2 datafeed
work for** — the gain is real but incremental, not transformative.

**Priority:** EXPLORATORY — flagged, reasoned lead with real numbers behind
it now, but still no commitment to build. Revisit whenever chart-feel polish
or Gate 2 datafeed work is next picked up.

**Update 2026-07-25 (later) — Kraken+Coinbase combined-venue lead measured,
and a bigger finding fell out of it:**

**1. Confirmed current state:** read `coinbaseWs.ts:79-132` — its
`market_trades` handler calls `aggregateTick()` (candles) and
`addPressureSample()` (CVD/pressure) only. No `publish()`/`createEvent()`
call, no eventBus import at all. Coinbase's trade stream still does not
feed `price.tick` — unchanged since the original multi-asset Gate 0 recon.

**2. Coinbase BTC/USD trade frequency measured** (same discipline — temporary
`console.log` tags in both `krakenWs.ts` and `coinbaseWs.ts` trade handlers,
89s live window, reverted after, clean `git diff` confirmed on both files):

- **Coinbase: 376 raw trade msgs/88.8s ≈ 4.24/sec** — Kraken over the same
  window: **28 msgs/88.8s ≈ 0.32/sec**. Coinbase is carrying **~13× Kraken's
  raw BTC/USD trade volume** on this platform right now.
- This alone is the headline finding: **Coinbase is already connected
  (`coinbaseWs.ts`, subscribed to `market_trades`) and already receiving far
  more BTC/USD trade data than Kraken — it just isn't wired to `price.tick`.**

**3. Combined-rate math, correcting for overlap (not naive addition):**

- Naive sum (Kraken + Coinbase raw): 404 msgs/88.8s ≈ 4.55/sec — but merging
  the two timelines and collapsing near-duplicate timestamps (<100ms apart,
  a reasonable "would a human perceive these as separate updates" cutoff)
  drops it to **173 distinct events/88.8s ≈ 1.95/sec** — most of the "loss"
  is same-venue burst redundancy (Coinbase's own cascading fills), not
  cross-venue overlap: only a handful of Kraken ticks landed within 100ms of
  a Coinbase tick at all.
- More importantly, raw message count overstates *visible* movement the same
  way it did for the book channel: filtering to messages where the price
  actually changed from the immediately-preceding tick (any venue) gives the
  real comparison:
  - **Coinbase-alone price-change rate: 114/376 msgs ≈ 1.28 changes/sec**
  - **Kraken+Coinbase combined price-change rate: 145/404 msgs ≈ 1.63
    changes/sec**
  - Combining only adds **~27% over Coinbase alone** (1.28 → 1.63/sec) for
    BTC/USD, because Kraken simply doesn't carry enough of this platform's
    BTC volume to move the needle much once Coinbase is already in the mix.
  - Burstiness is genuinely better than either single-venue trade feed or the
    book channel, though: combined price-change gaps were median 312ms, mean
    612ms, **max 4.6s** — versus ~17-18s max gaps for Kraken-trade-alone or
    the book channel. Combining does measurably tame the worst-case silence,
    even though the average-rate gain over Coinbase-alone is modest.

**4. Open design questions (flagged, not resolved):**

- **Cross-venue price divergence is real, not hypothetical** — directly
  observed in this sample: Kraken's BTC/USD trades printed consistently
  **$1.68-$4.36 (0.003-0.007%) *above*** the concurrent Coinbase price
  throughout the whole window (a persistent small spread, not noise bouncing
  both directions). A naive "whichever venue ticked most recently wins"
  `price.tick` source would visibly micro-flicker the hero price by that
  amount on every venue-switch event. This needs either a smoothing/
  volume-weighted approach, or — more simply — just not naively
  round-robin-ing between venues (see recommendation below).
- **Does not generalize evenly across pairs**, confirmed by the XLM/USD
  spot-check (below): the liquidity skew toward Coinbase is *even more*
  lopsided on a thinner pair, so a combination strategy tuned for BTC/USD
  would need to be liquidity-aware per pair, not a flat rule. All 75 active
  pairs *are* listed on both venues (`exchange_symbol_map` has
  `coinbase,kraken` for all 75 checked), so venue coverage isn't the
  problem — relative liquidity balance per pair is.
- **No architectural conflict with the eventBus/interest-set design**: the
  interest-set filter in `v1Events.ts` gates purely on `pairId`, not on which
  upstream feed produced the event — swapping or dual-sourcing `price.tick`'s
  publisher (`krakenWs.ts` → `coinbaseWs.ts`, or both) is a backend
  publisher-side change only; `v1Events.ts`, `datafeedAdapter.ts`, and all
  client code are unaffected.

**5. XLM/USD spot-check** (thinner pair, same instrumentation, ~85s window
captured alongside the BTC/USD run):

- Coinbase: 131 msgs/84.9s ≈ 1.54/sec. Kraken: **3 msgs/84.9s ≈ 0.035/sec**
  — Kraken carried essentially none of this pair's trade volume in the
  sample window (0 of those 3 landed within 100ms of a Coinbase tick).
- Price-change rate: Coinbase-alone 75/131 ≈ 0.88 changes/sec; combined
  79/134 ≈ 0.93 changes/sec — combining added **~5%** over Coinbase alone,
  even less benefit than BTC/USD saw. Gaps were also more uneven (mean
  1075ms, max 14.9s) than BTC's combined numbers — thinner liquidity means
  even the dominant venue (Coinbase here) can't fully close the gap.
- **Takeaway: the thinner the pair, the less combining Kraken adds** —
  Kraken's contribution shrinks faster than Coinbase's as liquidity drops,
  so a per-pair "is combining worth it" calculation would mostly come back
  "no" outside of a few venue-balanced pairs.

**Recommendation — comparing all three measured leads on real numbers:**

| Lead | Rate vs. current baseline (~0.17-0.26/sec) | Worst-case gap | Semantics change | Complexity |
|---|---|---|---|---|
| Book-channel mid-price (prior update) | ~0.79/sec (~3-4×) | ~17s | last-trade → quote-mid (real tradeoff) | needs mid-change filtering (94% noise) |
| **Coinbase-primary trade feed** | **~1.28/sec (~5-7×)** | not separately isolated, bounded by Coinbase-alone gaps | **none — still last-trade** | **low — repoint one publisher, source already connected** |
| Kraken+Coinbase combined | ~1.63/sec (~6-9×) | ~4.6s (best of the three) | none — still last-trade | medium-high — venue divergence smoothing, per-pair liquidity weighting |

**Coinbase-primary is the strongest lead of the three** — the biggest rate
improvement relative to its complexity, because Coinbase is *already
connected and already receiving the data*; this is a "repoint one publish
call" change, not a new subsystem. **Full two-venue combination is a real
but secondary refinement** — it only adds ~5-27% over Coinbase-alone
(shrinking further on thinner pairs) while introducing genuine complexity
(cross-venue divergence smoothing, per-pair venue weighting) — worth
revisiting only if Coinbase-alone proves insufficient in practice, not worth
building first. **Book-channel mid-price is the weakest of the three** —
smallest rate gain *and* the only one requiring a last-trade → mid-price
semantics change — park it unless the trade-side options are tried first and
still fall short.

**Priority:** EXPLORATORY — still no commitment to build any of the three.
If Gate 1 picks this thread up, the suggested order is Coinbase-primary
first (cheap, biggest win), combined-venue second (only if needed), book
channel last (only if still needed after both trade-side options).

**Update 2026-07-25 (later still) — promoted to Gate 1, implementing:** the
Coinbase-primary option above is being designed + implemented on branch
`gate1-coinbase-price-tick`. Full design lock (event shape, fallback
decision, downstream-consumer check, all-75-pairs confirmation) is in
`docs/designs/2026-07-25-price-tick-coinbase-source-gate1.md` — this entry
stays as the historical recon trail; see that doc for the current state of
this specific lead.

---

## 🔵 LOW — Tier/ELO badge (toolbar + Profile) doesn't refresh when a match ends mid-session

**Discovered:** 2026-07-25, Gate 1 tier-badge design lock
(`docs/GATE_1_TIER_BADGE_DESIGN.md`). Deliberately scoped OUT of that work at
Roberto's direction — tracked here as a separate future fix, not bundled.

**Context:** the new toolbar `TierBadge` and `ProfilePage`'s ELO bar both read
`userTier`/`eloRating` from `competitionStore`, populated by `fetchUserTier()`
— called once on app init (`App.tsx`) and once on `ProfilePage` mount. Neither
call site re-fires when a 1v1 match completes.

**Gap:** `resolveMatchElo` (`eloService.ts`) updates a player's `elo_rating`
and `user_tiers.tier` server-side the moment a match ends, and `useSSE.ts:141-144`
already dispatches a global `sse:match.ended` window `CustomEvent` on every
match end (mounted unconditionally in `AppLayout`, fires on every route). But
nothing subscribes to that event to refresh tier/ELO — so the toolbar badge
and Profile's ELO bar stay stale (showing the pre-match rating/tier) until the
next full page load or `ProfilePage` remount.

**Fix (small, own PR):** add a `window.addEventListener("sse:match.ended", ...)`
that calls `useCompetitionStore.getState().fetchUserTier()` — mirrors the
existing SSE-listener pattern already used in `ArenaPage.tsx`/`LiveMatchView.tsx`,
reuses an event that's already global. Should ideally only fire when the
current user was a participant in the ended match (payload already carries
`challenger_id`/`opponent_id`), to avoid an unnecessary fetch on every
stranger's match completing.

**Priority:** LOW — badge is accurate immediately after login/reload and after
navigating to/from Profile; the staleness window is specifically "stayed on
one page through an entire match's end," not a correctness bug in the data
itself.

---

## 🟢 LOW (downgraded from MEDIUM, root cause confirmed) — Kraken WS connection instability causing intermittent `stale_price_source` rejections

**Discovered:** 2026-08-13, as a side effect of Track 2 (agent-concurrency
load testing) — NOT found via direct investigation of the ingestion path.
`agentConcurrencyTest.ts`'s Test B precondition check (`resolveSnapshot`
returning `source="fallback"` for BTC/USD) failed twice in a row against a
dev server that had been up for hours. Investigating why led here.

**Hard evidence, one local dev server, ~9.5h uptime:**
- **65** `[krakenWs] connected` events, **62** `[krakenWs] No ticks for 30s —
  reconnecting...` events over that window (`src/market/krakenWs.ts:362-363`).
- At least one `getaddrinfo ENOTFOUND ws.kraken.com` (DNS resolution failure)
  and one `read ECONNRESET` among the reconnect triggers.
- **Confirmed whole-connection, not BTC/USD-specific**, by reading the actual
  watchdog code: `lastTickAt` (`krakenWs.ts:78`) is a single module-level
  variable, updated by `handleTickerMessage` (`krakenWs.ts:135`) on receipt of
  *any* ticker message for *any* of the ~137 subscribed symbols on this one
  connection. The 30s watchdog (`krakenWs.ts:362`) fires when **zero** ticker
  messages arrived for **zero** symbols in 30+ seconds — a connection-wide
  silence, not a per-pair liquidity gap.
- Reconnects cluster in bursts (several within seconds of each other) with
  longer healthy stretches between clusters (12-78 minutes observed between
  the outer structured `[footprint] Kraken WS connected/closed` log pairs) —
  intermittent, not constantly broken, but recurring often enough that two
  independent test attempts both landed in a dead window.
- Directly confirmed live via Redis: `cp:snap:BTC/USD` genuinely goes
  **missing** (`TTL -2`, i.e. key does not exist, not just past the app's 10s
  staleness check) for stretches of 20-30+ seconds, then reappears with a
  fresh write, repeatedly.

**Confirming evidence, same night — two more real Test B failures:**
- **Run at 2026-08-13T02:23:01Z** — `checkLiveSnapshotOrAbort` still had its
  original single point-in-time check (no polling yet). Failed immediately:
  `source="fallback"` on the first and only call. This is the failure that
  triggered the investigation documented above.
- **Run at 2026-08-13T02:32:43Z** — after adding a 30-second bounded poll
  (retry every 1.5s, abort only past the deadline) specifically to
  accommodate this documented gap, Test B **still failed** — 21 consecutive
  poll attempts over the full 30-second window, every single one
  `source="fallback"`. A direct Redis check taken immediately after showed a
  **fresh** tick at `2026-08-13T02:33:27.066Z`, roughly 10 seconds after the
  script gave up — i.e. this particular outage lasted at least the full 30
  seconds the harness was willing to wait, then resolved on its own shortly
  after. This is a materially longer real-world gap than the original
  "20-30+ second" `TTL -2` observation implied on its own — it shows the
  outage duration can meet or exceed a full 30-second client-side retry
  budget, not just brush past the original 10s staleness TTL.
- **Net result:** Execution Agent's row-lock/idempotency concurrency logic
  (the actual thing Track 2 Test B was built to exercise) was never reached
  in either attempt — both failures happened at the precondition check,
  before any `executeTradeProposal()` call ever ran. Track 2 Test B is
  **blocked by this issue**, not failed as a script bug.

**Production impact — concrete, not hypothetical:** `resolveSnapshot`'s
staleness check (`snapshotStore.ts`, 10s TTL) combined with a connection that
goes fully silent across all symbols for 30+ seconds on a recurring basis
means `stale_price_source` (`executor.ts:236-247`) is a **real, non-rare
rejection mode** for actual Execution Agent runs — not just an artifact of
how the Track 2 test script's precondition check was written. Some fraction
of otherwise-good `approved` trade_proposals are likely being rejected at
execution time because the price feed itself dropped out from under them
momentarily, not because the market actually moved past the execution
tolerance. This has not been separately confirmed against Railway prod
specifically — only measured on local dev tonight — but the mechanism
(single shared WS connection, global watchdog, no per-pair fallback) is not
dev-only code, so it's a reasonable concern in prod too until checked.

**Root cause NOT determined — intentionally left open, not fixed tonight.**
Three open hypotheses, unranked:
1. Local network flakiness between this dev machine and `wss://ws.kraken.com`
   specifically (would not necessarily reproduce on Railway).
2. Kraken-side behavior under a single connection subscribed to ~137 symbols
   at once (ticker/trade/book channels all subscribed together,
   `krakenWs.ts:100-102`) — e.g. rate-limiting, silent backpressure, or
   connection resets triggered by subscription breadth.
3. Something else not yet isolated (reconnect/resubscribe logic itself,
   `ws` library behavior, etc.).

No production-log correlation, no Railway-specific reproduction, no fix
proposed yet. Next step for whoever picks this up: check whether the same
reconnect pattern appears in Railway prod logs, and/or test whether a
narrower per-connection symbol subscription reduces reconnect frequency,
before assuming cause #1 or #2.

**Priority:** MEDIUM — not confirmed actively broken in prod (reserving HIGH
for that), but a real, evidenced gap between "an approved trade got the
market wrong" and "an approved trade got rejected because our own feed blinked,"
which undermines trusting `stale_price_source` rejection counts as a market
signal until this is understood.

**Update 2026-08-13 (later) — two independent Kraken connections found, both
correlate with Coinbase:** further investigation traced the full connection
lifecycle in both `krakenWs.ts` and the separate, independently-reconnecting
`footprintAggregator.ts` socket (same Kraken host, same process/IP, its own
reconnect loop — not previously documented as a second connection). Reading
Kraken's own WS v2 docs confirmed subscribing ~137 symbols on one connection
is explicitly supported and not expected to hit connection limits, which
weighs against hypothesis 2. Timing correlation across a ~22.5h log
(`tradr-api-track2.log`) found all ~26 distinct outage events landed within
0-5 seconds across Kraken-main, Kraken-footprint, **and Coinbase** (an
unrelated exchange, separate infra) — Coinbase dropping in lockstep with
Kraken is strong evidence against a Kraken-side subscription-breadth issue,
since Kraken's behavior can't explain Coinbase failing at the same instant.
Two explicit errors captured (`getaddrinfo ENOTFOUND ws.kraken.com`,
`read ECONNRESET`) are both OS/socket-layer, not application-level Kraken
rejections. Leading hypothesis narrowed to **local/network-path flakiness**,
with a candidate secondary concern: since `krakenWs.ts` and
`footprintAggregator.ts` are two independent auto-reconnecting sockets from
one IP, a shared network blip could make both race to reconnect
simultaneously, pushing combined attempts toward Kraken's documented
Cloudflare-edge limit of ~150 reconnects/10min per IP (which bans the IP for
10min if exceeded) — this was not yet tested with real data at this point.

Diagnostic logging (pure, no behavioral change) was added to both
`krakenWs.ts` and `footprintAggregator.ts`: WS `close` event code/reason
logged at the point reconnect is scheduled, plus a new shared module
(`src/market/krakenReconnectTracker.ts`) tracking a rolling 10-minute count
of combined reconnect attempts across both connections, logged on every
reconnect as `combinedReconnectCount10m`. A single clean dev server instance
was started to run this unattended and collect real data before concluding
which hypothesis was correct.

**Update 2026-08-15 — root cause CONFIRMED via 53.5h of diagnostic data:**
the dev server ran continuously for ~53.5 hours (2026-08-13 17:03 UTC →
2026-08-15 22:30 UTC, PID stayed alive throughout, no crash/restart),
producing 193 reconnect events (159 from `krakenWs.ts`, 34 from
`footprintAggregator.ts`) with real `closeCode`/`closeReason`/
`combinedReconnectCount10m` data:

- **Close codes: 95% code 1006 (184/193), 5% code 1005 (9/193).** Both are
  TCP/transport-layer failure signatures — 1006 means "abnormal closure, no
  close frame received" (the connection just died mid-stream) and 1005 means
  "no status code present." Neither is an application-level close.
  `closeReason` was an **empty string on all 193 events, with no
  exceptions** — Kraken's server never sent an explanation, consistent with
  the connection simply dropping rather than being deliberately closed by
  either Kraken or Cloudflare. If this were a Cloudflare-side rejection
  (rate-limit ban, policy violation), the expected signature would be a
  distinct code like 1008 with an actual reason string — that pattern never
  appeared once in 193 events.
- **`combinedReconnectCount10m` stayed low throughout: range 1-7, histogram
  1→96, 2→56, 3→27, 4→10, 5→2, 6→1, 7→1.** The single worst moment (7) hit
  during a 3-reconnect cluster on 2026-08-14 17:46-17:51 UTC. Even that worst
  case is **~4.7% of Kraken's documented ~150/10min Cloudflare threshold**,
  with no upward drift across the full 53.5h window.

**Both original hypotheses now resolved, not just narrowed:**
1. **NOT a Kraken-side subscription limit** — ruled out both by Kraken's own
   docs (many-symbols-per-connection is explicitly supported) and now by
   data: a subscription-breadth issue would not produce uniform
   transport-layer close codes with zero application-level rejections.
2. **NOT a Cloudflare rate-limit / two-connections-racing amplification** —
   this was a live, testable theory as of the 2026-08-13 update, and the
   53.5h data disproves it directly: `combinedReconnectCount10m` never
   climbed past 7, nowhere near the ~150 threshold, across every storm
   observed including the worst one.
3. **Confirmed: local/network-path instability**, most likely outside this
   codebase's control (home/office network path to `wss://ws.kraken.com`,
   not reproducible as a Kraken-side or Cloudflare-side behavior from this
   evidence).

**Recommendation — no code fix proposed for the WS connection layer.** The
existing reconnect-with-backoff behavior in both `krakenWs.ts` and
`footprintAggregator.ts` is already the correct mitigation for a
transport-layer failure mode like this — it recovered every single time
across 193 events over 53.5h, which is the behavior you want from a
reconnect loop facing genuine network flakiness. There is nothing
Kraken-side or Cloudflare-side to work around, so a connection-layer change
would not address the actual cause. The remaining real issue is downstream,
not in the WS layer: **`stale_price_source` rejections on genuinely good
trades** during these (now-understood, still-recurring) outage windows. If
that rejection rate ever becomes a practical problem in production, the fix
belongs in the Execution Agent's tolerance/staleness handling (e.g. a
slightly longer grace period on `resolveSnapshot`'s staleness check, or a
retry-based approach like the one already used elsewhere in Gate 1e) — not
in the WS connection layer, which is already behaving correctly given a
flaky network path it can't control.

**Priority:** downgraded from MEDIUM to LOW — the original MEDIUM reflected
genuine uncertainty about whether this was a fixable connection-layer bug
(worth prioritizing) or unfixable network flakiness (not directly
actionable). That uncertainty is now resolved: root cause is understood,
confirmed not fixable from this codebase, and the reconnect logic already
handles it correctly. Keeping this entry (rather than closing it outright)
because it explains a real, recurring `stale_price_source` rejection pattern
that would otherwise look like an unexplained mystery to whoever next
investigates Execution Agent rejection rates.
