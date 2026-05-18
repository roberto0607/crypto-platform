# Commit 4 — Anti-Gameability Investigation: Match Cancel Stale-Counter Exploit

**Pass type:** READ-ONLY diagnosis. No code changed. No commits.
**Date:** 2026-05-18
**Hypothesis under test:** `matchService.ts`'s cancel path gates on a trade
counter that is only written at match end, letting a losing player cancel a
live 1v1 to dodge the ELO loss a forfeit would impose.

**Verdict: (A) — Exploit confirmed.** See Section 5.

---

## Section 1 — Functions found (Step 1)

### 1a. Functions that move a match away from ACTIVE without completing it

| Function | File | Notes |
|---|---|---|
| `cancelActiveMatch(userId)` | `matchService.ts:422` | The cancel path. Transitions PENDING/ACTIVE → `CANCELLED`. **This is the suspect.** |
| `matchCleanupJob.run()` | `jobs/definitions/matchCleanupJob.ts:11` | Background job. Raw `UPDATE` of PENDING/ACTIVE/OVERTIME → `CANCELLED`. Does **not** call `completeMatch`/`forfeitMatch`. See Side findings. |

No other function in `matchService.ts` contains "cancel" or transitions out of ACTIVE non-terminally.

### 1b. `completeMatch` and `forfeitMatch` — both still exist post-3b

- **`forfeitMatch`** (`matchService.ts:194`): ACTIVE → `FORFEITED`. Calls `closeMatchScopedPositions`, recomputes stats via `calculatePlayerStats`, writes `*_trades_count`, then calls `resolveMatchElo` — **the loser eats the ELO loss.**
- **`completeMatch`** (`matchService.ts:273`): ACTIVE → `COMPLETED`. Same shape — closes positions, computes stats, writes `*_trades_count`, calls `resolveMatchElo`.

Both apply ELO. The cancel path does **neither** — no `resolveMatchElo`, no `closeMatchScopedPositions`.

### 1c. `challenger_trades_count` / `opponent_trades_count` columns

Columns **still exist** — declared in `migrations/057_trade_wars.sql:90-91`:

```sql
challenger_trades_count  INTEGER NOT NULL DEFAULT 0,
opponent_trades_count    INTEGER NOT NULL DEFAULT 0,
```

Not renamed. Mirrored in the `MatchRow` interface (`matchService.ts:26-27`).

### 1d. `MIN_TRADES` / `MIN_MATCH_TRADES`

- **`MIN_MATCH_TRADES`** — gone everywhere. Zero hits in `apps/api/src` or `apps/web/src`. Sub-commit 3c removal confirmed clean; nothing in the cancel path ever referenced it.
- `MIN_TRADES` survives only as **unrelated** symbols: `WEEKLY_MIN_TRADES = 5` (weekly competitions) and a local `const MIN_TRADES = 5` in `scripts/simCompetition.ts`. Neither touches 1v1 matches.

No numeric trade-count threshold gates the cancel path — the gate is simply `totalTrades > 0`.

---

## Section 2 — State transition table (Step 2)

| Function | Triggers from state | New state | ELO impact | Trade-count check? |
|---|---|---|---|---|
| `createMatch` | (none) | `PENDING` | none | no |
| `acceptMatch` | PENDING | `ACTIVE` | none | no |
| `forfeitMatch` | ACTIVE | `FORFEITED` | **Yes** — `resolveMatchElo` (loser loses ELO) | no — recomputes stats live regardless |
| `completeMatch` | ACTIVE | `COMPLETED` | **Yes** — `resolveMatchElo` | no — recomputes stats live regardless |
| `cancelActiveMatch` | PENDING / **ACTIVE** | `CANCELLED` | **none** | **Yes — reads persisted `match.*_trades_count` columns** (`matchService.ts:441`) |
| `matchCleanupJob` | PENDING / ACTIVE / OVERTIME (expired) | `CANCELLED` | none | no |

The trade-count source for `cancelActiveMatch` is the **persisted match row columns**, read straight off the `SELECT * ... FOR UPDATE` at line 427:

```ts
// matchService.ts:440-445
if (match.status === "ACTIVE") {
    const totalTrades = (match.challenger_trades_count ?? 0) + (match.opponent_trades_count ?? 0);
    if (totalTrades > 0) {
        throw new Error("match_has_trades");
    }
}
```

It is **not** a live query, **not** a parameter — it is the stored column.

---

## Section 3 — Trade count write trace (Step 3)

Every write to a `*_trades_count` column, repo-wide:

| Write site | Function / file | Match-state condition | Timing |
|---|---|---|---|
| `matchService.ts:232-233` | `forfeitMatch` | UPDATE in the ACTIVE→`FORFEITED` statement | **once, at terminal state** |
| `matchService.ts:313-314` | `completeMatch` | UPDATE in the ACTIVE→`COMPLETED` statement | **once, at terminal state** |
| `seed-demo-data.ts:243` | seed script | `INSERT ... 'COMPLETED'` rows | seed-time only, never live |

**There is no incremental write.** Nothing increments `challenger_trades_count` /
`opponent_trades_count` on order fill, on trade creation, or anywhere in the
trading engine. The values flow exclusively from `calculatePlayerStats`
(`matchService.ts:514`), which is itself called **only** by `completeMatch` and
`forfeitMatch`.

**Consequence:** for the entire lifetime of an ACTIVE match, both columns hold
their migration default of `0`. They become non-zero only in the same UPDATE
that moves the match to a terminal state — i.e. *after* the match is already
over. The cancel path reads them while the match is still ACTIVE, so it always
reads `0 + 0 = 0`.

The hypothesis is **correct**: the counters are written once at match end, never
during the match. The cancel guard reads stale zeros.

(Note: the *real* live trade count exists — `calculatePlayerStats` derives it
from `SELECT count(*) FROM orders WHERE match_id=$1 AND user_id=$2 AND status='FILLED'`
at `matchService.ts:535-539`. The cancel path simply doesn't use it.)

---

## Section 4 — Cancel call path (Step 4)

- **Route:** `POST /v1/matches/active/cancel` — `routes/v1/v1Matches.ts:173-188`.
- **Handler:** calls `cancelActiveMatch(req.user!.id)` with no body, no params.
- **Auth/permissions:** `preHandler: requireUser` only — any authenticated user.
  `cancelActiveMatch` resolves the match by `challenger_id = $1 OR opponent_id = $1`,
  so **either player** can cancel **their own** match. No "challenger only"
  restriction, no time-window restriction, no admin gate.
- **Frontend:** `apps/web/src/api/endpoints/matches.ts:54` exposes
  `cancelActiveMatch()`; `ArenaPage.tsx:269` wires it to `handleCancelActiveMatch`,
  a user-clickable button. The FE even has a branch for the `match_has_trades`
  error ("Match has trades — use FORFEIT instead.") — but that error can never
  be produced for a genuinely traded live match (Section 3), so the branch is
  dead in the exploit scenario.

---

## Section 5 — Exploit verdict

### VERDICT: (A) — Exploit confirmed.

A player (challenger or opponent) in match state **ACTIVE** can call route
**`POST /v1/matches/active/cancel`**, which executes function
**`cancelActiveMatch`**, which checks counters **`challenger_trades_count` +
`opponent_trades_count`** that are currently **`0`** because those columns are
only written by **`completeMatch` / `forfeitMatch`** at terminal states
(Section 3). `totalTrades > 0` evaluates false, the guard does not throw, and
the match transitions to **`CANCELLED`**. `CANCELLED` is excluded from
`getMatchHistory`'s `IN ('COMPLETED','FORFEITED')` filter, `resolveMatchElo` is
never invoked, and `closeMatchScopedPositions` is never invoked. The player
**avoids the ELO loss** that `forfeitMatch` would have applied — and also
escapes having their open losing positions force-closed into the match score.

This is strictly better for a losing player than forfeiting: forfeit → loser
loses ELO + positions booked; cancel → no ELO change + positions untouched. The
intended "if the match has trades you must forfeit" rule is fully bypassed
because the gate reads a counter that is structurally always zero mid-match.

**Severity:** high — it nullifies match integrity. Anyone losing a ranked 1v1
clicks Cancel instead of Forfeit and walks away rating-neutral.

### Contingency to verify (does not change the verdict, affects only blast radius)

`migrations/057_trade_wars.sql:83-84` defines the `matches.status` CHECK
constraint as `IN ('PENDING','ACTIVE','COMPLETED','FORFEITED','EXPIRED')` —
which does **not** include `'CANCELLED'`. Migration `063_ghost_match_indexes.sql`
ends with a *comment* saying CANCELLED should be added to the check "if one
exists" but contains **no actual `ALTER`**. If the constraint is still enforced
in the live DB, the `UPDATE ... SET status='CANCELLED'` would raise a check
violation and roll back — which would *accidentally* block the exploit (and
would also mean `matchCleanupJob` has been erroring every 5 minutes). Since the
platform is deployed and the cleanup job + `MatchRow` type both treat
`CANCELLED` as normal, the constraint was almost certainly relaxed in prod (an
untracked `ALTER`) — so the exploit is live. This should be confirmed against
the production DB before shipping the fix, but it does not soften the verdict:
the logic bug in `cancelActiveMatch` is unconditional and real either way.

---

## Section 6 — Fix sketch

- **What the gate should check instead:** replace the read of the persisted
  `match.*_trades_count` columns with a **live query** inside `cancelActiveMatch`,
  for the `status === "ACTIVE"` branch only. Count real fills for the match:
  `SELECT count(*) FROM orders WHERE match_id = $1 AND status = 'FILLED'`
  (run on the same `client`/txn). If `> 0`, throw `match_has_trades`.
- **Canonical "is this match live and substantive?" source:** the existing
  `calculatePlayerStats` already uses exactly this query
  (`matchService.ts:535-539`) as the authoritative trade count. The fix should
  reuse that same `orders ... status='FILLED'` count, not the `positions` table
  and not the stale columns. (Consider filtering out `is_system_fill` orders for
  cleanliness — though mid-ACTIVE no synthetic close orders exist yet, since
  those are only created by `closeMatchScopedPositions` at terminal state.)
- **Scope:** essentially a **one-function change** — only `cancelActiveMatch`
  (~lines 440-445) needs editing; swap the column arithmetic for one `client.query`.
  No change to `completeMatch`, `forfeitMatch`, routes, or the FE. Optionally,
  consider whether a match with fills should be force-forfeited rather than just
  rejected, but that is a product decision beyond the minimal security fix.

---

## Section 7 — Tests touched by the fix path

- **No existing test exercises the cancel path.** `cancelActiveMatch` /
  `/matches/active/cancel` has zero references in any `*.test.ts` or smoke
  script. `competitions/__tests__/matchScopedPositions.test.ts` covers
  `completeMatch` and `forfeitMatch` only.
- Therefore the fix **breaks no existing test**, but a **regression test should
  be added**: place a FILLED order in an ACTIVE match, assert
  `cancelActiveMatch` throws `match_has_trades`, and assert it still succeeds
  for an ACTIVE match with zero fills and for any PENDING match.
  `matchScopedPositions.test.ts` already has the fixture scaffolding (creates a
  match, fills an order) and is the natural home for it.

### Side findings (noted, not fixed — out of scope for this pass)

1. **`matchCleanupJob` bypasses match resolution entirely.** For an ACTIVE
   match whose timer expired (`ends_at` > 5 min ago), the job does a raw
   `UPDATE ... SET status='CANCELLED'` (`matchCleanupJob.ts:27-35`) — no
   `completeMatch`, no `resolveMatchElo`, no `closeMatchScopedPositions`. Every
   1v1 that simply runs its full duration without a manual `completeMatch` call
   ends up `CANCELLED` with **no ELO awarded to the winner**. Combined with
   finding #2, this means ranked matches effectively never resolve in
   production. This is arguably a larger bug than the cancel exploit.
2. **`completeMatch` has no production caller.** Repo-wide, `completeMatch` is
   invoked only from tests and scripts (`smoke-match-lifecycle.ts`,
   `test-elo-e2e.ts`). No job, route, or service calls it. Matches have no
   path to a `COMPLETED` terminal state in normal operation.
3. **`matches.status` CHECK constraint vs. code mismatch.** Migration 057's
   CHECK omits `CANCELLED` and `OVERTIME`; migration 063 only *comments* about
   adding `CANCELLED` without an `ALTER`. Yet the code writes both `CANCELLED`
   (cancel path, cleanup job) and `OVERTIME` (cleanup job reads it as an input
   state). Schema and code are out of sync — verify the live constraint.
