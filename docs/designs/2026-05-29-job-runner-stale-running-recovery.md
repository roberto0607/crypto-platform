# Design: job-runner stale-RUNNING recovery (PR B)

**Status:** in implementation — code + tests complete and green locally, awaiting commit & deploy · **Date:** 2026-05-29 · **Author:** market-maker-not-filling investigation (PR B)
**Tracks:** `docs/followups.md` → HIGH "Market-maker bot not quoting in prod → LIMIT orders never fill in solo play" (filed 2026-05-27 during PR #32). This PR is the durable fix; the bot was unwedged manually on 2026-05-30 (see §a).

## a. Problem

A user placing a resting **LIMIT** order in solo prod play saw it sit at `OPEN`
forever while the reference price moved straight through the limit — it never
filled. MARKET orders worked (they fall back to a system fill at
`trading_pairs.last_price`); LIMIT orders have no such fallback, so they only
fill when a counterparty crosses them. The intended counterparty is the
market-maker bot, which posts resting bids/asks around the live price. It wasn't
posting anything.

The user-visible symptom — "limit orders don't fill" — turned out to be a
**data-state corruption in the job runner's scheduling table**, two layers below
where it manifested.

Prod evidence from the diagnostic (queried against the production `job_runs`
table):

```
job_name     | last_status | last_started_at               | last_finished_at              | next_run_at
market-maker | RUNNING     | 2026-03-30 16:01:07.900001+00 | 2026-03-30 15:59:51.963805+00 | 2026-03-30 16:00:01.963805+00
```

The tell is the **inversion**: `last_started_at` (16:01:07) is *after*
`last_finished_at` (15:59:51). A run began at 16:01:07 and **never finished** —
the process died mid-run before it could write a terminal status. The row has
been frozen in `RUNNING` ever since.

Corroborating: the bot had placed **4,356 orders** historically, but the most
recent was `2026-03-30 15:44` — the bot went completely dark at exactly the time
the row wedged, ~2 months before this investigation. The live order book held
only the user's own stuck LIMITs plus 12 stale bot orders frozen at March prices;
no fresh quotes.

**Reference — what past-me got wrong.** The HIGH-priority followup filed on
2026-05-27 (during PR #32's order-visibility work) correctly diagnosed the
*behavior* ("no bot quoting → nothing crosses a solo user's resting limit") and
listed two candidate causes: (1) `DISABLE_MARKET_MAKER` set in prod env, and
(2) the `marketMakerJob` not registered/running or the bot user/wallets missing.
**Both were wrong.** The env was clean (`DISABLE_MARKET_MAKER` unset,
`DISABLE_JOB_RUNNER` unset, `INSTANCE_ROLE` defaulting to `ALL`), the job *was*
registered, the bot user *did* exist with funded wallets, and the job runner *was*
actively running other jobs. The bug was in a layer past-me didn't think to look
at: the `job_runs` row's `last_status` value and the predicate that reads it.

The bot was restored to prod immediately via a targeted `UPDATE` (reset the row's
`last_status` to `SUCCESS`) on 2026-05-30 00:24 UTC, and confirmed quoting (a
`$50` MARKET BUY filled against a resting bot ask, `is_system_fill=false`). That
manual unwedge is a one-time patch — **this PR prevents the class of bug from
recurring.**

## b. Root cause

Two cooperating gaps in `apps/api/src/jobs/jobRepo.ts`:

1. **`findDueJobs` has no escape from `RUNNING`.** Its predicate excluded any row
   whose `last_status = 'RUNNING'` (so a job already executing isn't double-dispatched).
   But there was no upper bound: a row stuck in `RUNNING` is excluded on *every*
   tick, forever. Once wedged, the job is dead until a human intervenes.

2. **`upsertJobRow`'s `ON CONFLICT DO UPDATE` never resets `last_status`.** It
   updated only `interval_seconds`. So restarting the API process — the obvious
   thing an operator would try — does nothing to unstick the row; the stale
   `RUNNING` survives every redeploy.

Together these mean: any job whose process dies between `markStarted` (which sets
`RUNNING`) and `markFinished` (which writes the terminal `SUCCESS`/`FAILED`) is
wedged permanently, surviving restarts.

**This is a job-runner bug, not a market-maker bug.** All five scheduled jobs —
`market-maker`, `candle-rollup`, `competition-lifecycle`, `competition-leaderboard`,
`kraken-candle-sync` — run through the same `markStarted`/`findDueJobs` path and are
equally vulnerable. Market-maker simply lost the dice roll first: it runs every 10s
(the most frequent job), so it had the highest odds of being mid-tick when a process
died.

**Trigger.** The kill has to land in the window between `markStarted` and
`markFinished`. A graceful `SIGTERM` is handled (the runner awaits in-flight jobs on
shutdown), but a hard kill — `SIGKILL`, or `SIGTERM` whose grace period expires
mid-run — leaves the row orphaned. The 2026-03-30 16:01 incident was almost
certainly a Railway deploy that replaced the container while market-maker was mid-tick.

## c. Design decisions

Four questions, each with the decision and why:

1. **Staleness rule → per-job `maxRunSeconds`, default `LEAST(interval_seconds * 5, 300)`.**
   A new nullable column on `job_runs`; `NULL` means "use the default," computed in
   SQL at query time. A per-job value forces each job's author to think *once* about
   that job's realistic worst-case duration, while the default keeps zero-ceremony
   scheduling for routine jobs. A run older than this ceiling is treated as crashed
   and becomes reclaimable.

2. **Reclaim location → HYBRID: inline predicate in `findDueJobs` *and* a startup
   reset in `start()`.** The startup reset (`UPDATE … SET last_status='FAILED' WHERE
   last_status='RUNNING'`, run once per boot before the loop starts) is the direct
   antidote to the March 30 trigger — a deploy kill leaves exactly one orphaned row,
   and the next boot clears it immediately. The inline `findDueJobs` predicate is the
   general safety net: it recovers a row even if the process *stays up* but somehow
   left a row in `RUNNING` (e.g. an uncaught crash in a fire-and-forget path), and it
   bounds worst-case recovery to one staleness window even without a restart.

3. **Concurrency safety → defensive idempotent claim in `markStarted`.** The caller
   passes the `last_started_at` it observed at selection time; the `UPDATE` only
   claims the row if that value is unchanged (or the row is no longer `RUNNING`),
   returning `null` so the caller skips when it lost a race. The comparison uses
   `date_trunc('milliseconds', …)` on **both sides** — see the precision note below.
   This is belt-and-suspenders: the `pg_try_advisory_lock` in `runJob` is the primary
   serializer (only one worker executes a given job at a time), and the conservative
   per-job thresholds (every `maxRunSeconds` ≥ 1.2× its effective timeout) make a real
   selection race vanishingly unlikely. The check exists so that *if* the design is
   ever scaled to multiple workers, a torn claim fails closed rather than double-running.

   **The millisecond-precision subtlety (and why it nearly shipped a re-wedge).**
   `node-postgres` parses `timestamptz` into a JS `Date`, which has *millisecond*
   resolution, but `now()` writes *microseconds*. So the value a caller reads back from
   `findDueJobs` and passes into `markStarted` is already ms-truncated, and a raw
   `last_started_at IS NOT DISTINCT FROM $2` against the microsecond column is **false
   on the round-trip even when nothing changed**. For the stale-RUNNING reclaim path
   that is fatal: the row *is* still `RUNNING` (so the "not RUNNING" arm is false) and
   the timestamp arm is falsely false → the claim returns `null` → the runner logs
   "claimed by another worker" and skips → **the very row this PR exists to recover is
   never claimed.** This was caught empirically before writing tests (a throwaway probe
   inserted `now()`, read it back through the driver, and showed `IS NOT DISTINCT FROM`
   matched 0 rows while `date_trunc('milliseconds', …)` matched 1). Truncating both
   sides to milliseconds makes the round-trip lossless; ms granularity is far finer
   than any real claim race, and V8 truncates (not rounds) sub-ms, so the comparison is
   exact.

4. **Tests → integration-style against real local Postgres** via the `pool` singleton,
   mirroring the `matchCleanupJob.test.ts` / `walletRepo.test.ts` convention (a mock
   can't exercise interval arithmetic, `COALESCE`, `IS [NOT] DISTINCT FROM`, or the
   driver's `timestamptz→Date` round-trip — and the round-trip *is* the bug). The suite
   includes **Test 3b**, a findDueJobs→markStarted round-trip test, added specifically
   because the precision bug was found by probe before tests existed: without 3b, the
   four originally-planned tests all pass *with the broken `IS NOT DISTINCT FROM`
   version*, so the precision re-wedge would have shipped green. 3b is the discriminator
   that fails on the broken version and passes on the fix.

## d. Implementation

- **`apps/api/migrations/068_add_max_run_seconds.sql`** — adds nullable
  `max_run_seconds INTEGER` to `job_runs` (idempotent `ADD COLUMN IF NOT EXISTS`) and
  backfills existing rows to `LEAST(interval_seconds * 5, 300)`. `NULL` = "use app
  default"; the backfill is a one-time convenience.
- **`apps/api/src/jobs/jobTypes.ts`** — adds optional `maxRunSeconds?: number` to the
  `JobDefinition` interface, with JSDoc explaining the semantics and the "≥ timeoutMs/1000"
  guidance.
- **`apps/api/src/jobs/definitions/*.ts` (5 files)** — per-job `maxRunSeconds`
  declarations, each with a value-legible comment (e.g. market-maker `30` ≈ 1.2× its 25s
  timeout; competition-lifecycle `600` = 5× its 120s timeout). Every value sits above the
  job's effective `timeoutMs` so the stale-reclaim predicate can never fire on a job
  that's still legitimately inside its own run timeout.
- **`apps/api/src/jobs/jobRepo.ts`** —
  - `JobRow.max_run_seconds: number | null`, and `last_started_at` retyped to `Date | null`
    (it was mistyped as `string`; the driver returns a `Date` — a pre-existing latent bug
    fixed here since the surrounding code now depends on the real type).
  - `upsertJobRow` takes and writes `maxRunSeconds` (re-applied from the definition on
    every boot via `ON CONFLICT`, so code stays authoritative).
  - `markStarted` — defensive, ms-precision idempotent claim returning the new
    `last_started_at` or `null`; an `undefined` `expectedStartedAt` (manual-trigger path)
    claims unconditionally.
  - `resetStaleRunningOnStartup()` — the single `UPDATE … SET last_status='FAILED',
    last_error='reset on startup (was RUNNING)' WHERE last_status='RUNNING'`, returning the
    row count. Lives in the repo (not inline in the runner) so it's directly unit-testable.
  - `findDueJobs` — predicate extended with the stale-RUNNING escape hatch:
    `OR last_started_at < now() - COALESCE(max_run_seconds, LEAST(interval_seconds * 5, 300)) * interval '1 second'`.
- **`apps/api/src/jobs/jobRunner.ts`** — `start()` calls `resetStaleRunningOnStartup()`
  first and logs the count (singular/plural, logged even when 0); `tick()` threads the
  selected row's `last_started_at` into `runJob`, which passes it to `markStarted` and, on
  a `null` return, logs "Job claimed by another worker, skipping" and returns without
  throwing.

## e. Manual prod verification plan

After merge + deploy (file this as a one-time post-deploy task in `docs/followups.md`):

1. **Steady-state log check.** Tail `crypto-platform` logs on Railway across a deploy.
   Expect on each boot: `Job runner startup: reset N stale RUNNING rows`. `N=0` is the
   healthy steady state (nothing was wedged); `N≥1` means a prior boot died mid-tick and
   this boot recovered it — informative either way, which is why it logs even at 0.
2. **Deploy-kill recovery (the actual repro).** Restart the `crypto-platform` service via
   Railway's restart button during the first ~0–10s of a market-maker quoting cycle (i.e.
   mid-tick). Confirm:
   - next boot logs `Job runner startup: reset 1 stale RUNNING row (was running before this boot)`;
   - market-maker resumes quoting within ~one tick (~10s);
   - the `job_runs` row for `market-maker` flips `RUNNING → FAILED → RUNNING → SUCCESS`
     within ~30s of the restart.
3. **End-to-end fill.** As `rtirado0607@gmail.com`, place a marketable LIMIT BUY in prod
   and confirm it fills against a bot ask with `is_system_fill = false` — the same
   end-to-end check used when the bot was unwedged on 2026-05-30.

## f. Out of scope

- **Multi-worker scoping (a `worker_id` column on the startup reset).** Prod runs a single
  API instance (`INSTANCE_ROLE=ALL`), and the job runner is leader-gated, so today the
  startup reset only ever sees its own orphans. If the API is scaled out, the unconditional
  `WHERE last_status='RUNNING'` reset could preempt a sibling worker's legitimately-running
  row; at that point the reset needs to scope to its own `worker_id`. Solvable, unnecessary now.
- **Heartbeats for in-flight jobs.** A periodic heartbeat would be the most accurate
  staleness signal (vs. a fixed worst-case ceiling), but it requires threading a heartbeat
  through every job body. For five jobs, per-job `maxRunSeconds` is simpler and covers the
  observed failure mode (process death, not pathological slowness).
- **Transactional job bodies.** Wrapping each run in a transaction is the textbook
  concurrency answer but adds operational weight to every future job. Conservative timeouts
  + the advisory lock are sufficient here.
- **`pg_try_advisory_lock` without an explicit `pg_advisory_unlock` in `runJob`** (the lock
  rides the pooled connection until release; may cause lock-contention false positives if
  the pool reuses a connection holding a stale session lock). Pre-existing, surfaced during
  this PR's review, filed as a separate LOW-priority followup (commit 2) to keep PR scope tight.

## g. Acceptance criteria

- A row stuck in `RUNNING` **past** its `maxRunSeconds` threshold is reclaimable by
  `findDueJobs` (Test 1).
- A row in `RUNNING` **within** its threshold is **not** reclaimed — no over-recovery of a
  legitimately-running job (Test 2).
- Two workers selecting the same due row results in exactly one claim; the loser bails
  cleanly with a `null` return (Test 3).
- The end-to-end reclaim path — `findDueJobs` → `markStarted` with the **driver-returned**
  `last_started_at` — succeeds for a stale `RUNNING` row, exercising the ms-precision
  compare (Test 3b, the round-trip discriminator).
- A `RUNNING` row at process startup is reset to `FAILED` with a `last_error` naming the
  cause (Test 4).
- Manual verification: a Railway restart mid-tick recovers within one tick, with no stuck
  rows persisting (§e).

## h. References

- PR #30 — XLEN queue depth metric (2026-05-27)
- PR #31 — candles `timeframe='1m'` index pin (2026-05-27)
- PR #32 — open-orders dock + cancel; the market-maker followup was filed during this work (2026-05-27)
- Related code: `apps/api/src/jobs/jobRepo.ts`, `apps/api/src/jobs/jobRunner.ts`
- 2026-03-30 incident: prod `job_runs` row history — bot's last quote at 15:44 UTC, wedge at `last_started_at = 16:01:07.900001 UTC`; manual unwedge 2026-05-30 00:24 UTC
