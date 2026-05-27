# Design: fix the Redis order-queue XLEN depth bug

**Status:** proposed — revised per review 2026-05-26 (awaiting final approval) · **Date:** 2026-05-26 · **Author:** baseline load-test session
**Tracks:** `docs/followups.md` → "Redis order queue bricks per-pair after 100 lifetime orders"

## Problem (recap)

`enqueueRedis` rejects with `pair_queue_overloaded` (HTTP 503) once a pair's
stream reaches `config.maxQueueDepth` (100). Depth is measured with
`XLEN(stream)` (`redisQueue.ts:202`), but the consumer `XACK`s **without**
removing the entry (`redisQueue.ts:432`). `XACK` only clears the pending-entries
list; the entry stays in the stream, so `XLEN` counts every order ever added and
never shrinks. After 100 lifetime `XADD`s per pair (between restarts) every order
503s, even with the consumer fully drained (`pending=0, lag=0`, verified). Only
the boot-time flush (`XTRIM MAXLEN 0`, `redisQueue.ts:109-125`) clears it. The
in-memory backend can't exhibit this — it checks `pq.jobs.length`
(`queueManager.ts:77`), which shrinks as jobs drain.

---

## a. Chosen fix and trade-offs

Three options were on the table (from followups.md). Analysis:

| Option | Mechanism | Latency | Correctness | Complexity | Risk |
|---|---|---|---|---|---|
| **(a) `XDEL` after `XACK`** | remove the entry once processed | +1 cheap cmd/job | XLEN→true live depth; stream bounded | trivial (1 line) | low |
| (b) guard on lag+pending | replace XLEN with `XINFO GROUPS` lag + `XPENDING` | +2 cmds/enqueue (hot path) | most "correct" signal | parse XINFO, handle null lag | medium |
| (c) `XADD … MAXLEN ~ N` | cap stream on write | none | **trims OLDEST = can drop UNPROCESSED orders** | low | **high — data loss** |

**Decision: Option (a) — `XDEL` the message immediately after `XACK`.**

Why (a):
- Makes `XLEN` a faithful proxy for "not-yet-fully-processed" entries (unread
  backlog + read-but-unacked in-flight) — exactly what the depth guard wants.
  With a single consumer reading `COUNT 1`, in-flight is ≤1, so `XLEN` ≈ true
  backlog and drops to ~0 when idle. This restores the in-memory semantics
  (`jobs.length` = unprocessed work).
- Bounds stream growth, so it also fixes the **unbounded-memory** side of the bug
  (the stream currently grows forever).
- One-line change, lowest risk, no new failure modes.

Why not (b): it fixes the false 503 but **does not trim the stream**, so Redis
memory still grows unboundedly — you'd need (a)'s trimming anyway. It also adds
two commands and XINFO-parsing brittleness on the enqueue hot path for a signal
that (a) approximates correctly. More cost, more code, less complete.

Why not (c): `MAXLEN` evicts the **oldest** entries regardless of ack state — under
a slow consumer it would silently drop **unprocessed orders**. Unacceptable for an
order queue. Rejected outright.

Defense-in-depth — **decided against for this PR** (review 2026-05-26): a periodic
`XTRIM` was considered as belt-and-suspenders but rejected to keep the PR a single
focused change with a clean rollback. (a) alone keeps `XLEN` correct, so it isn't
needed; if we later find we want it, it ships as its own PR. The boot-time flush
stays as-is.

---

## b. Exact code changes (no code written yet)

**Primary file: `apps/api/src/queue/redisQueue.ts`, function `processJob` (lines 382-435)** (plus a new metric in `metrics.ts` — see Observability below).

Today, after publishing the result, the tail of `processJob` is:

```
await redis.xack(streamKey(pairId), GROUP_NAME, msgId);     // line 432
const depth = await redis.xlen(streamKey(pairId));          // line 433 (metric)
pairQueueDepth.set({ pairId }, depth);                       // line 434
```

Change: **add an `XDEL` of `msgId` immediately after the `XACK`**, before the
`XLEN`. Sequence becomes XACK (clear PEL) → XDEL (remove from stream) → XLEN
(now reflects true depth) → set metric. Net: one added `redis.xdel(streamKey(pairId), msgId)`.

Notes for the implementer:
- `XDEL` is a normal keyed command, so it receives the ioredis `cp:` prefix —
  use `streamKey(pairId)` (the un-prefixed form), identical to the adjacent
  `xack`/`xlen` calls. Do **not** use `rawStreamKey` (that's only for the
  prefix-exempt `XGROUP`/`XINFO` subcommands).
- Place the `XDEL` in the same spot for **both** the success and error branches —
  i.e. after the `try/catch` that publishes the result, in the existing "ACK +
  update depth" tail (which already runs unconditionally). A job that threw still
  produced a terminal result published to the caller, so its message is done and
  must be removed; leaving it would re-introduce the leak for error-heavy load.
- Bonus: the existing `pairQueueDepth` gauge (line 434) becomes accurate for free
  — it currently reports the same monotonic XLEN.
- No change to the enqueue-side guard (line 202): once entries are deleted on
  completion, `XLEN` there is already the correct live depth.
- No change to `config.maxQueueDepth` (100 stays a sane real-depth cap).

### Observability (ships in this PR — turns "fix and pray" into "fix and monitor")

This class of bug is silent when broken, so the fix ships with monitoring:

- **New counter `pair_queue_xdel_failures_total{pairId}`** (add to `metrics.ts`,
  register on the default registry). Wrap the new `XDEL` in try/catch and
  increment this counter on any caught error. The `XDEL` must **never break the
  ack/processing flow** — a failed delete degrades to the old leak for that one
  message, not a crash.
- **Warn log when `XDEL` returns 0** (entry not found / already deleted).
  `redis.xdel` returns the count removed; 0 shouldn't happen on the happy path,
  so surface it at `warn` with `{ pairId, msgId }`.
- **Confirm `pair_queue_depth` is scraped:** the gauge is already defined
  (`metrics.ts`) and listed in `slo-baseline.md`'s metric inventory; verify it's
  actually emitted at `GET /metrics`:
  `curl -s localhost:3001/metrics | grep pair_queue_depth`. Post-deploy, **watch
  `pair_queue_depth{pairId=…}`** — it should sit near 0 and rise only with real
  backlog (instead of climbing monotonically). Watch the new
  `pair_queue_xdel_failures_total` on the same dashboard (expect flat 0).

Second touched file: **`apps/api/src/metrics.ts`** (the new counter).

**Out of scope for this PR:** the boot-time flush (109-125) stays as-is; the
in-memory path is already correct; `maxQueueDepth` tuning is a separate question.

---

## c. Test strategy

**Where:** alongside PR #27's tests in
`apps/api/src/queue/__tests__/redisQueue.integration.test.ts` — the **integration**
suite (real ephemeral Redis via `@testcontainers/redis`), run with
`pnpm test:integration` (excluded from default `pnpm test`). This bug, like the
PR #26 matchId bug that file already covers, is about **real `XLEN`/`XACK`/`XDEL`
semantics a mock can't reproduce** — the same reasoning the file's header
documents. It reuses the existing harness (mocked `placeOrderWithSnapshot`,
mocked metrics, `enqueueRedis`/`initRedisQueue`/`shutdownRedisQueue`).

Both tests **override `config.maxQueueDepth` to a small test-only value (e.g. 10)**
— mutate-and-restore in `beforeEach`/`afterEach` (or via the config-mock pattern).
Same proof as the real cap of 100, ~10× faster CI.

**New test 1 — "drains below cap; the (cap+1)th order succeeds" (the fix):**
1. Init the queue against the test container with `maxQueueDepth = 10`; mock
   `placeOrderWithSnapshot` to resolve fast (FAKE_RESULT).
2. Place `2 × cap` (= 20) MARKET orders on one pair, **awaiting each enqueue's
   resolution** — the promise resolves only after the consumer processed → acked →
   (with the fix) deleted the message, so this guarantees serial drain.
3. Assert `XLEN(streamKey) ≈ 0` (≤ a small in-flight slack), **not** 20.
4. Assert the (cap+1)th (= 11th) enqueue resolves successfully and does **not**
   throw `pair_queue_overloaded`.
   → Without the fix, this test fails at order ~`cap+1` (~11th) with
   `pair_queue_overloaded`.

**New test 2 — "genuine overload still rejects" (don't over-correct):**
1. Make the `placeOrderWithSnapshot` mock block on a manual gate so the consumer
   can't drain (same `maxQueueDepth = 10` override).
2. Fire `cap + 1` (= 11) enqueues without releasing the gate.
3. Assert the `(cap+1)`th rejects with `pair_queue_overloaded` (the guard still
   protects against real backpressure), then release the gate and assert the
   backlog drains to ~0.

This pair proves both directions: the false-positive 503 is gone, and the real
backpressure guard still fires.

---

## d. Migration risk (existing prod streams have inflated XLEN)

Prod streams currently hold accumulated acked-but-undeleted entries, so their
`XLEN` is inflated. **No one-shot migration script is needed:** the existing
boot-time flush (`redisQueue.ts:109-125`) runs `XTRIM MAXLEN 0` on every `queue:*`
stream at startup, so the first deploy carrying this fix resets every stream to 0.
From then on `XDEL`-on-completion keeps `XLEN` bounded.

Caveat to flag (pre-existing, not worsened by this fix): `XTRIM MAXLEN 0` is a
blunt flush that also drops any entries **in-flight at deploy time**. That's
already today's behavior on every restart, and at current load the window is
tiny — but worth a one-line note in the PR. If we ever want zero-loss deploys,
draining the queue before shutdown is a separate follow-up.

**Post-fix, deploy-time loss becomes more visible** because there's no longer
accumulated `XLEN` noise masking it. This is **not a regression** — the fix
removes camouflage, not safety. Acknowledge this in the PR body so future
debugging doesn't blame this PR.

**Post-deploy verification:** watch `XLEN cp:queue:<pair>` (or the
`pair_queue_depth` gauge) under normal traffic — it should hover near 0 and rise
only with genuine backlog, instead of climbing monotonically.

---

## e. Phase 2B implications

**Phase 2B's multi-pair scenario is still needed — and its purpose sharpens.**
Today's single-pair baseline could not measure real scaling because the XLEN bug
short-circuited every write scenario at 100 orders (the run hit a *false* ceiling,
not a real one). Once the depth guard tracks true backlog, Phase 2B uniquely tests
what today's baseline could not:

1. **Real single-pair throughput / saturation** — ramp load until one consumer
   genuinely can't keep up and depth climbs toward 100 for real. Finds the actual
   OPS-per-pair ceiling (today we only know "<100 lifetime orders → wall").
2. **Cross-pair concurrency (PR #28)** — BTC+ETH+SOL = three consumers, each with
   its own dedicated blocking Redis connection. Confirms the per-consumer
   connection model scales (no pool exhaustion / contention) under load — the
   load-side proof PR #28's unit regression test doesn't give.
3. **In-match order flow (PR #26 path)** — challenge/accept then concurrent
   in-match orders, exercising `getActiveMatchIdForUser` resolution at the edge
   under load (never hit by the free-play single-pair seed).
4. **Ramp/stress executors** — to find limits at all (today's flat constant-VUs
   can't).

**Sequencing:** fix XLEN first. If Phase 2B is built before the fix, every
write-heavy multi-pair run just re-hits the 503 wall and tells us nothing new.

---

## Decisions from review (2026-05-26)

- **Land (a) alone — no periodic `XTRIM`.** The fix is complete on its own;
  bundling a periodic trim would be two changes in one PR and complicate
  rollback. Separate PR if we ever find we need it.
- **Test-time cap, not the real cap.** Tests override `config.maxQueueDepth` to a
  small value (e.g. 10) and place ~20 orders — same proof, ~10× faster CI.
- **Observability ships with the fix** (see §b): `pair_queue_xdel_failures_total`
  counter, warn-on-`XDEL`-returns-0, and a documented post-deploy watch on
  `pair_queue_depth`.
