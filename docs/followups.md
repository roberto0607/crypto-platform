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

## 🔴 Redis order queue bricks per-pair after 100 lifetime orders (XLEN depth bug)

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

