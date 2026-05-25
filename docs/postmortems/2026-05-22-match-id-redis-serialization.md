# matchId-via-Redis serialization bug

## Timeline
- **Bug introduced**: when the Redis-backed queue was added to the order
  pipeline (exact date unknown, but migration 066 applied 2026-04-25 confirms
  the `match_id` column existed by then, so the bug existed for at least ~30
  days before the fix).
- **Bug reported**: 2026-05-20 — user observed "no close button in Live Match
  View" during a 1v1 match.
- **Root cause identified**: 2026-05-22 morning.
- **Fix shipped**: 2026-05-22 12:01 PM (PR #26 merged + Railway deploy + prod
  verification).
- **Regression test shipped**: 2026-05-22 1:05 PM (PR #27).

## Symptom
Users in active 1v1 matches could open positions (long or short) but the
position card and CLOSE POSITION button never appeared in Live Match View.
Users had to forfeit the match to escape an open position, losing -3 ELO. After
forfeit, the same position would appear on the home free-play page with a
working CLOSE POSITION button — effectively an unintended escape hatch.

## Root cause
`POST /orders` in `tradingRoutes.ts` called `enqueueOrder` with
`matchId=undefined`, intending `phase6OrderService` to resolve the user's active
match server-side via `getActiveMatchIdForUser`. This worked when `REDIS_URL`
was unset (the in-memory queue path preserved the JavaScript `undefined`). When
Redis was configured (prod), the enqueue path flattened `matchId` via
`matchId ?? ""`, storing an empty string in the stream. The dequeue path read it
back as `null`. `phase6OrderService`'s fallback treated `null` as "explicit
free-play" (distinct from `undefined`, which would trigger the lookup), so it
skipped the resolver. Every order and position created during an active match
was written with `match_id = NULL`.

The three-state contract (`undefined` = look it up / `null` = free-play /
`string` = explicit match) survived in-process function calls but collapsed to
two states across the Redis wire, and the lost state was precisely the one that
meant "look it up."

## Downstream impact
- Live Match View read path filtered `WHERE match_id = $activeMatchId`, found
  nothing, rendered no position UI.
- The forfeit handler's `closeMatchScopedPositions` found zero rows to close, so
  positions persisted across the match boundary.
- After forfeit, the orphan appeared in the free-play scope
  (`WHERE match_id IS NULL`).
- `cancelActiveMatch`'s "has filled trades?" gate (introduced in `7924b58` to
  close the cancel-to-dodge-ELO exploit) was structurally zero — the exploit was
  effectively reopened.
- `closeMatchScopedPositions` on match completion found zero rows, so match P&L
  calculations omitted all in-match positions.

## Scale at fix time
- 42 FILLED orders across 8 distinct matches placed with `match_id = NULL`.
- 7 of 8 matches ended in FORFEIT (consistent with users unable to close
  positions normally).
- 2 open orphan positions still in the database.
- ~30 days of production data affected.

## Diagnostic chain
1. Initial visible symptom: no close button in LMV.
2. Hypothesis 1: missing UI affordance — ruled out by reading
   `UnifiedOrderPanel.tsx`; the close button was conditionally rendered based on
   a `hasPosition` prop.
3. Hypothesis 2: the position prop was null at render — confirmed via a console
   diagnostic (React fiber inspection of `UnifiedOrderPanel`'s memoized props).
4. Inflection point: the user noticed that after forfeit, the position appeared
   on the home page. This collapsed multiple competing hypotheses into one: the
   position must have `match_id = NULL`.
5. Verified locally that the order placement pipeline worked correctly without
   Redis (in-memory queue path).
6. Identified the divergence: `REDIS_URL` set in prod, unset locally.
7. Reproduced the bug locally by setting `REDIS_URL` and re-running the match
   repro script.
8. Inspected the Redis stream entry directly via `XREVRANGE`, observed the
   `matchId` field stored as `""`.
9. Traced the serialization code in `redisQueue.ts` to the `matchId ?? ""`
   flattening at enqueue and the symmetric null conversion at dequeue.
10. Confirmed `phase6OrderService`'s fallback logic treated `null` as
    explicit-free-play, skipping the lookup.

## Fix
Resolve `matchId` at the HTTP edge in `tradingRoutes.ts` (call
`getActiveMatchIdForUser` before `enqueueOrder`). Pass a concrete
string-or-null through the queue. In Redis, serialize `null` as a distinct
sentinel `__free_play__` rather than an empty string; deserialize symmetrically.
Remove the `getActiveMatchIdForUser` fallback in `phase6OrderService` so the bug
class can't silently re-emerge — a wrong `null` now surfaces as the symptom
rather than being silently re-resolved.

The three-state contract collapses to a clean two-state wire protocol.

## Verification
- Local repro with `REDIS_URL` set: reproduced the bug, applied the fix,
  confirmed `match_id` stamps correctly on both orders and positions.
- Free-play path: still writes `match_id = NULL` correctly (not over-corrected).
- Cancel-exploit gate: filled-in-match count now > 0, cancel refused with
  `match_has_trades`, match stays ACTIVE.
- Match-completion P&L: `closeMatchScopedPositions` finds positions and
  force-closes them; `realized_pnl_quote` populates correctly.
- Full test suite: 239 passed (no regressions).
- Production verification 2026-05-22 12:01 PM: rtirado0607 vs demo match, both
  sides opened opposite positions in LMV, the close button appeared in both,
  positions closed cleanly with P&L recorded.

## Regression coverage
PR #27 added a Redis-queue integration test
(`apps/api/src/queue/__tests__/redisQueue.integration.test.ts`) that exercises
the actual `XADD` → `XREADGROUP` wire serialization against a real Redis
testcontainer. Four assertions cover both round-trip directions and the
defensive backward-compat for pre-fix queued jobs. A separate GitHub Actions
workflow (`.github/workflows/integration.yml`) runs the test on PRs that touch
the queue, trading, or `db/redis.ts` paths.

## What this teaches
The bug was structurally inevitable from the moment three semantic states had to
cross a wire that only carries two. The `undefined`/`null` distinction works
inside a single JS process but is not preserved by JSON, Redis stream fields,
HTTP form data, or most other serialization formats. Code that depends on this
distinction is fine until it crosses any boundary, at which point it silently
breaks.

Concrete corollaries:
- Functions that intend "resolve this server-side later" should not signal that
  intent via `undefined`-vs-`null`. Use an explicit sentinel (a string, a
  constant, a tagged union).
- The boundary where a value enters a queue (or any cross-process channel) is
  the right place to resolve any "look it up" semantics. Once a value enters a
  queue, what crosses must be the resolved form, not a deferred intent.
- Tests that only exercise the in-memory version of a queue (or any
  cross-process channel) do not test the serialization contract. A bug class
  that only manifests across the wire needs an integration test against the real
  wire.

## Latent issue surfaced during fix
While writing the regression test, observed that ioredis runs all commands over
a single connection by default. The queue's blocking `XREADGROUP` holds that
connection until it returns, which can starve concurrent `XADD`s and `PUBLISH`es
from other pairs. In prod this is currently masked by the market-maker bot
keeping all pair queues warm (blocking reads return quickly). During genuine
quiet periods or if the bot is down, enqueue latency on unrelated pairs could
spike up to the BLOCK timeout (~5s).

Fix direction (deferred to a follow-up PR): give the queue consumer its own
dedicated ioredis connection so the shared command connection remains
responsive.
