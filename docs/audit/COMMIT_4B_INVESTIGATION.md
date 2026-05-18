# Commit 4b — Match Resolution Overhaul: Investigation Pass

**Status:** READ-ONLY investigation. No code changed.
**Date:** 2026-05-18

**Decided product behavior (Roberto's call):** when an `ACTIVE` (or
`OVERTIME`) match's `ends_at` passes, the cleanup job calls `completeMatch`
— close positions at market, compute stats, apply ELO, transition to
`COMPLETED`. `PENDING` matches still go to `CANCELLED` on expiry.
Player-triggered resolution is out of scope.

---

## Section 1 — Current `matchCleanupJob`

File: `apps/api/src/jobs/definitions/matchCleanupJob.ts`

- **States swept** — three bulk `UPDATE` statements:
  1. `PENDING` with `created_at < now() - 2 hours`
  2. `ACTIVE` with `ends_at IS NOT NULL AND ends_at < now() - 5 minutes`
  3. `OVERTIME` with `ends_at IS NOT NULL AND ends_at < now() - 30 minutes`
- **Target status** — **all three transition to `CANCELLED`** with
  `completed_at = now()`. No stats, no position close, no ELO. The expired
  `ACTIVE` sweep silently nullifies matches that may have had real trades.
- **Transaction** — none. Three independent `ctx.pool.query` calls, each its
  own implicit autocommit statement.
- **Per-match error handling** — none, and not needed today because the work
  is set-based bulk SQL. If any statement throws, the whole `run` throws; the
  job runner (`jobRunner.ts:112`) catches it, marks the run `FAILED`, logs
  `"Job failed"`. There is no per-match isolation because there is no
  per-match loop.
- **Schedule / cadence** — `intervalSeconds: 300` (every 5 minutes),
  `timeoutMs: 30_000`. Registered in `apps/api/src/jobs/definitions/index.ts`
  (`allJobs` array, last entry).
- **Tests** — **none.** No `*.test.ts` references `matchCleanupJob`,
  `match-cleanup`, or this file. The job is completely untested.

## Section 2 — `completeMatch` verified behavior + idempotency

File: `apps/api/src/competitions/matchService.ts:273-351`

- **Signature** — `completeMatch(matchId: string): Promise<MatchRow>`. Takes
  only a match id. Opens its **own** client + transaction via
  `acquireClient()` — it does **not** accept an external `PoolClient`.
- **State transition** — `ACTIVE → COMPLETED` only. Guarded at line 285:
  `if (match.status !== "ACTIVE") throw new Error("match_not_active")`.
- **Steps (all inside one transaction):**
  1. `SELECT * FROM matches WHERE id = $1 FOR UPDATE` — row lock + status
     recheck.
  2. `closeMatchScopedPositions(matchId, client)` — force-closes every
     non-flat match-scoped `positions` row at market (snapshot →
     `trading_pairs.last_price` → `avg_entry_price` fallback chain), books
     realized PnL, writes synthetic `FILLED` orders + system trades.
  3. `calculatePlayerStats` for both players (PnL %, trade count, win rate,
     consistency, nuanced score).
  4. Determine `winner_id` by higher score; equal scores ⇒ `winner_id` stays
     `null` (draw).
  5. `UPDATE matches SET status='COMPLETED', <stats>, winner_id, completed_at`.
  6. `resolveMatchElo(matchId, client)` — full ELO/streak/tier/badge
     resolution.
  7. `COMMIT`.
- **Error handling** — single `try/catch` around the whole body; **any**
  throw (from `closeMatchScopedPositions`, `calculatePlayerStats`, the
  `UPDATE`, or `resolveMatchElo`) triggers `ROLLBACK` and re-throws. The
  transaction is all-or-nothing: a `resolveMatchElo` failure rolls back the
  `COMPLETED` status write too, so the match stays `ACTIVE`. Good — no
  partial completion.
- **Idempotency — THE CRITICAL ANSWER:** `completeMatch` is **NOT a no-op**
  on an already-`COMPLETED` match. The second call hits the line-285 guard
  and **throws `match_not_active`**, rolling back. However, ELO is **never
  double-applied**, for three independent reasons:
  1. The `SELECT ... FOR UPDATE` row lock serializes concurrent callers; the
     loser re-reads `status = 'COMPLETED'` *inside its transaction* and
     throws before doing any work.
  2. The status guard rejects any non-`ACTIVE` match.
  3. `resolveMatchElo` is itself idempotent — it early-returns `null` if
     `match.elo_resolved` is already `true` (`eloService.ts:201`).
  **Verdict: safe under the cleanup-job race, but it signals "already done"
  by throwing, not by returning quietly.** The new job loop MUST catch
  `match_not_active` and treat it as benign (already resolved by a prior run
  or a concurrent runner) — otherwise every second job tick logs a spurious
  `FAILED`.

## Section 3 — `OVERTIME` state status

`OVERTIME` is **vestigial / dead.** Findings:

- The **only** occurrences of the string `OVERTIME` in the entire codebase
  are three lines inside `matchCleanupJob.ts` (the doc comment + the sweep).
- **No writer exists.** No code path transitions a match *into* `OVERTIME`
  — not `acceptMatch`, not any route, not any job. `apps/web/src` contains
  zero references to `OVERTIME`.
- It is **not** in `MatchRow.status` union type
  (`matchService.ts:21` lists `PENDING|ACTIVE|COMPLETED|FORFEITED|EXPIRED|
  CANCELLED` — note `OVERTIME` absent, `CANCELLED` present but `EXPIRED`
  unused).
- It is **not** in any tracked `CHECK` constraint. Migration 057 declared
  `CHECK (status IN ('PENDING','ACTIVE','COMPLETED','FORFEITED','EXPIRED'))`;
  migration 067 dropped that constraint entirely (its comment claims prod
  diverged to accommodate `CANCELLED`/`OVERTIME`, but no code ever writes
  `OVERTIME`).
- **Row count** — the local DB has **0 matches total** (see Section 5), so 0
  in `OVERTIME`. Prod not queried this pass.

**Conclusion:** the `OVERTIME` sweep branch has never fired and never can,
because nothing produces `OVERTIME` rows. 4b should treat `OVERTIME` as dead:
the new job needs to handle `ACTIVE` only. Note that even if `OVERTIME` rows
existed, `completeMatch`'s line-285 guard (`status !== "ACTIVE"`) would
*reject* them — so "complete OVERTIME like ACTIVE" is not possible without
also widening that guard. Recommendation: do not redesign around `OVERTIME`;
either drop the branch or, at most, keep cancelling it.

## Section 4 — All `matches.status` writers

Every writer found (`grep "UPDATE matches"` + `INSERT INTO matches` in
`apps/api/src`). All are within the expected set — **no surprise writer:**

| Writer | File:line | Transition |
|---|---|---|
| `createMatch` | `matchService.ts:91` (INSERT) | → `PENDING` (column default) |
| `acceptMatch` | `matchService.ts:156` | `PENDING → ACTIVE` |
| `forfeitMatch` | `matchService.ts:226` | `ACTIVE → FORFEITED` |
| `completeMatch` | `matchService.ts:309` | `ACTIVE → COMPLETED` |
| `cancelActiveMatch` | `matchService.ts:458` | `PENDING|ACTIVE → CANCELLED` |
| `matchCleanupJob` | `matchCleanupJob.ts:18,28,39` | `PENDING|ACTIVE|OVERTIME → CANCELLED` |

Non-status writes (do not change `status`): `eloService.ts:206,319` set only
`elo_resolved`/`elo_delta`. One test writer:
`__tests__/matchScopedPositions.test.ts:330` resets a row to `PENDING` for
test setup (not production code).

**Key finding for the verdict:** `completeMatch` is imported by
`matchService.ts` consumers — but `apps/api/src/routes/v1/v1Matches.ts` does
**not** import it (it imports `createMatch`, `acceptMatch`, `forfeitMatch`,
`cancelActiveMatch`, and the getters). The only callers of `completeMatch`
anywhere are the integration test and two scripts (`smoke-match-lifecycle.ts`,
`test-elo-e2e.ts`). **`completeMatch` has zero production callers today.** In
the running system, a match that simply runs out its timer is *never*
completed — the cleanup job cancels it. This is the core defect 4b fixes.

## Section 5 — Backlog count

Query attempted against the **local** DB (`tradr_postgres`, port 5435):

```sql
SELECT count(*) FROM matches WHERE status = 'CANCELLED'
  AND id IN (SELECT DISTINCT match_id FROM orders
             WHERE status = 'FILLED' AND match_id IS NOT NULL);
```

**Result: 0 — but uninformative.** The local DB has **0 rows in `matches`
total** (`SELECT count(*) FROM matches` = 0). The local environment has no
match data, so it cannot estimate the real backlog.

**Interpretation:** the count of ranked matches silently nullified by the old
"expired `ACTIVE` → `CANCELLED`" sweep can only be measured against
**production**. That query was deliberately not run this pass (local-only
scope). It should be run before the 4b commit so the commit message can cite
a real number, and the result feeds a future (out-of-scope-for-4b) data-
cleanup task. **We are not backfilling these matches in 4b.**

## Section 6 — Fix sketch

Replace the bulk `ACTIVE → CANCELLED` sweep with a per-match loop:
`SELECT id FROM matches WHERE status='ACTIVE' AND ends_at IS NOT NULL AND
ends_at < now() - interval '5 minutes'`, then `for` each id call
`await completeMatch(id)` inside its own `try/catch` so one match's failure
(or a benign `match_not_active` from a concurrent/prior run) is logged and
the loop continues to the next match — bulk SQL gives no isolation, a loop
must. Keep the `PENDING → CANCELLED` sweep exactly as-is (existing behavior
preserved). Drop the `OVERTIME` branch, or leave it cancelling — it is dead
either way (Section 3); do not try to "complete" `OVERTIME` since
`completeMatch`'s `status !== "ACTIVE"` guard would reject it.
`completeMatch` needs **no modification** to be job-callable: it already
manages its own `acquireClient()` transaction and takes only a `matchId`, and
its `FOR UPDATE` lock + status recheck + `resolveMatchElo`'s `elo_resolved`
flag make it race-safe — the job loop just must catch `match_not_active` and
treat it as benign rather than a failure.

**New tests required** (none exist for the job today — create a job test
file, e.g. `apps/api/src/jobs/__tests__/matchCleanupJob.test.ts`, following
the live-Postgres integration pattern of `matchScopedPositions.test.ts`):

1. Expired `ACTIVE` match (with fills) → run job → match is `COMPLETED`,
   stats populated, `match_elo_results` row exists, ELO applied.
2. Expired `PENDING` match → run job → match is `CANCELLED` (regression
   guard for preserved behavior).
3. Expired `ACTIVE` match where `completeMatch` throws (e.g. force an error
   via a fixture) → match stays `ACTIVE`, the job does not throw, and a
   *second* expired match in the same run still gets processed (error
   isolation).
4. Idempotency: run the job twice back-to-back on the same expired `ACTIVE`
   match → match `COMPLETED`, exactly **one** `match_elo_results` row,
   `elo_resolved = true`, ELO delta applied once; the second run's
   `match_not_active` is swallowed without a `FAILED` job result.

## Section 7 — Open questions & risks

1. **`completeMatch` throws instead of no-ops on re-entry.** This is the most
   important behavioral nuance: it is *safe* (ELO never doubles) but it
   communicates "already done" via a thrown `match_not_active`. If the 4b job
   loop does not explicitly catch and downgrade that error, every job tick
   after the first will mark the run `FAILED` and emit error logs. Treat
   `match_not_active` as a benign, expected outcome in the loop.

2. **`completeMatch` has zero production callers today.** The normal
   timer-expiry → completion path does not exist in the running system at
   all; `completeMatch` is exercised only by a test and two scripts. 4b is
   not just changing the cleanup job — it is wiring up a completion path that
   has never run in production. Treat the first prod deploy as activating new
   behavior, not tweaking existing behavior.

3. **Zero-trade expired `ACTIVE` matches.** Under the new logic, an `ACTIVE`
   match where both players accepted but neither traded will go through
   `completeMatch`: stats are 0/0, `winner_id` stays `null` (draw),
   `resolveMatchElo` marks `elo_resolved = true` with no ELO change, status
   becomes `COMPLETED`. Previously such a match was `CANCELLED`. **Decision
   needed:** is a no-trade expired match a `COMPLETED` draw or should it
   still be `CANCELLED`? The decided behavior says "ACTIVE → completeMatch"
   unconditionally, which produces a draw — flagging so it is a conscious
   choice, not an accident.

4. **Job timeout vs. per-match cost.** `timeoutMs` is 30 s. `completeMatch`
   does real work per match (position close with a possible market-snapshot
   lookup, synthetic order/trade inserts, full ELO resolution). A large
   backlog of expired matches in a single tick could exceed 30 s, and
   `completeMatch` does not honor `ctx.signal` (AbortSignal). Consider a
   per-tick batch cap (e.g. `LIMIT N` on the select) so each run is bounded;
   remaining matches are picked up on the next 5-minute tick.

5. **Stale type/constraint drift (side findings, not blockers).**
   `MatchRow.status` (`matchService.ts:21`) lists `EXPIRED` (no writer
   anywhere — also vestigial) but omits `OVERTIME`. Migration 067 dropped the
   `matches_status_check` constraint and its comment anticipates 4b re-adding
   a corrected `CHECK`. 4b is the right time to add a migration with
   `CHECK (status IN ('PENDING','ACTIVE','COMPLETED','FORFEITED','CANCELLED'))`
   — dropping the never-used `EXPIRED` and `OVERTIME` — and to fix the
   `MatchRow` union to match.

6. **Backlog number is unknown.** The Section 5 query must be run against
   production before the commit to quote a real figure. Not done this pass
   by scope rule.

---

## Section 8 — Mutual Forfeit Verification

**Context:** 4b will add `mutualForfeitMatch(matchId)` for an `ACTIVE` match
that expires with **zero `FILLED` orders**. Both players "forfeit":
`ACTIVE → FORFEITED`, `winner_id = NULL`, **both** players take an ELO loss.
This section verifies whether `resolveMatchElo` can produce that outcome.

### Step 1 — `resolveMatchElo` (eloService.ts:179-360)

- **Signature** — `resolveMatchElo(matchId: string, client: PoolClient):
  Promise<MatchEloResult | null>`. Must be called inside a transaction.
- **Winner/loser determination** — reads `winner_id` **off the match row**
  (`SELECT ... FROM matches WHERE id = $1 FOR UPDATE`, line 192). It is *not*
  a parameter. `loserId` is derived: the non-winner of
  `{challenger_id, opponent_id}` (line 211).
- **`winner_id = NULL` behavior** — handled at lines 204-208:
  ```
  if (!match.winner_id) {
      // Draw — mark resolved but no ELO changes
      await client.query(`UPDATE matches SET elo_resolved = true WHERE id = $1`, ...);
      return null;
  }
  ```
  This is a **pure no-op**: it applies **zero** ELO change to either player —
  not a symmetric change, not a small change, *nothing*. It also **sets
  `elo_resolved = true`** and returns `null`.
- **Status branching** — **none.** `status` is `SELECT`ed into the row type
  (line 186) but is **never read** anywhere in the function body (confirmed
  by grep — the only two `status` hits are the type field and the SELECT).
  `resolveMatchElo` applies the *identical* formula regardless of whether the
  match is `COMPLETED` or `FORFEITED`. The forfeit-vs-complete distinction
  lives entirely in the *caller* (which sets `winner_id`), not here.
- **`elo_resolved` idempotency flag** — **checked** at line 201
  (`if (match.elo_resolved) return null;`); **set** in two places: line 206
  (the NULL-winner draw branch) and line 319 (end of normal resolution).

### Step 2 — `forfeitMatch` call path (matchService.ts:194-268)

- `forfeitMatch` computes `winnerId` itself = the **non-forfeiting** player
  (line 211), then `UPDATE matches SET status='FORFEITED',
  forfeit_user_id=$forfeiter, winner_id=$winnerId, ...` (line 226).
- It then calls `resolveMatchElo(matchId, client)` (line 255) — passing
  **only** `matchId` + the txn client. It passes **no** winner explicitly;
  `resolveMatchElo` re-reads the just-written `winner_id` from the row.
- **Full trace — challenger forfeits:** `winnerId = opponent_id` →
  `matches` row becomes `status='FORFEITED', winner_id=<opponent>` →
  `resolveMatchElo` reads `winner_id` (non-null) → runs the **normal**
  resolution: opponent gains ELO (+ win streak/multiplier/badge, win_count+1),
  challenger loses ELO (loss_count+1, loss_streak+1). `status='FORFEITED'`
  has **zero** effect on the math — a forfeit and a played-out win apply the
  same ELO table.

### Step 3 — Mutual-forfeit answer: **Case (B)** (with a sharper correction)

`resolveMatchElo` does **not** natively produce a both-players-lose result
(rules out **A**), and it does **not** error on `winner_id=NULL` — it handles
it gracefully (rules out **C**; draws via `completeMatch`'s tie path are
*not* broken, they simply produce no ELO change, which is presumably
intended). So the answer is **(B)** — but note (B)'s wording is too generous:
the NULL-winner path is **not a "symmetric small change," it is a literal
no-op (zero ELO).**

**Critical consequence:** calling `resolveMatchElo` on a mutual-forfeit match
(`winner_id=NULL`) would be actively harmful — it would **set
`elo_resolved=true` and apply nothing**, *poisoning* the match so any
subsequent correct ELO write is permanently blocked by the line-201
idempotency guard. `mutualForfeitMatch` therefore **must not** call
`resolveMatchElo` for the penalty; it needs its own ELO path.

### Step 4 — Implementation impact

`mutualForfeitMatch` needs a **new, dedicated ELO path** — `resolveMatchElo`
cannot be reused (it no-ops on `winner_id=NULL`) and should *not* be modified
to special-case mutual forfeit (its whole contract is winner-driven; bolting
a status/flag branch onto it muddies the one function every other path
depends on). Instead, write the penalty inline (mirroring the winner/loser
update blocks at `eloService.ts:252-282`): for **each** player apply
`ELO_TABLE[playerTier].lose` (negative), `elo_rating = max(0, elo + delta)`,
`loss_count+1`, `loss_streak+1`, `win_streak=0`, insert an `elo_history` row
with `change_reason='MATCH_LOSS'`, and run `checkDemotion`; no streak
multiplier, no badges, no promotion. The match-row signature of a mutual
forfeit is `status='FORFEITED'`, `winner_id=NULL`, and — to stay idempotent
under the cleanup-job race — `elo_resolved=true` written in the same txn
(set it directly, since `resolveMatchElo` won't).

### Open questions / risks

1. **`match_elo_results` cannot represent a no-winner result.**
   `winner_id`/`loser_id` are `UUID **NOT NULL** REFERENCES users(id)`
   (migration 061:18-19), and the winner/loser ELO columns are all `NOT
   NULL`. A mutual forfeit has no winner, so it **cannot** write a normal
   `match_elo_results` row. Options: (a) skip `match_elo_results` for mutual
   forfeits — `getMatchHistory` already `LEFT JOIN`s it, so a missing row is
   tolerated and `winner_elo_delta`/`loser_elo_delta` come back `NULL`; or
   (b) a small migration making `winner_id`/`loser_id` nullable + adding a
   `result_type` discriminator. **Decision needed** — recommend (a) for 4b
   scope; per-player deltas still land in `elo_history`.
2. **`matches.elo_delta` is a SINGLE `INTEGER` column** (057:98), not two.
   The task brief's "both `elo_delta` columns negative" assumption is
   incorrect — there is one column. It currently stores the *winner's*
   delta. For a mutual forfeit there is no single delta; either leave it
   `NULL`, or store one player's loss (ambiguous). Per-player deltas should
   be sourced from `elo_history.old_elo/new_elo`, not `matches.elo_delta`.
3. **`forfeit_user_id` is a single nullable UUID** (057:97). A mutual forfeit
   has no single forfeiter — leave it `NULL`. Confirm nothing keys off
   `forfeit_user_id` being non-null for `FORFEITED` matches (quick grep in
   the impl pass).
4. **Stale code note (side finding):** `applyEloChange` (eloService.ts:120)
   has **no callers** — its doc comment claims "Used by `forfeitMatch`," but
   `forfeitMatch` actually uses `resolveMatchElo`. It is dead code; do not
   build `mutualForfeitMatch` on it.
5. **Empirical check for the impl pass** — the NULL-winner no-op is clear
   from the code, no ambiguity to flag. As a regression guard during
   implementation, add a test: seed an `ACTIVE` match with zero `FILLED`
   orders, run `mutualForfeitMatch`, assert *both* users' `elo_rating`
   dropped, both `loss_count` incremented, both `win_streak=0`, two
   `elo_history` `MATCH_LOSS` rows exist, and the match is
   `FORFEITED`/`winner_id=NULL`/`elo_resolved=true` — then run it a second
   time and assert no further ELO movement (idempotency).
