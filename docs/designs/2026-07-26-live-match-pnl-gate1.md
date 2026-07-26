# Gate 1 Design Lock — Live 1v1 Match PnL Push

Design only. No implementation in this pass. Builds on the Gate 0 recon
findings supplied with this task: `matches.challenger_pnl_pct` /
`opponent_pnl_pct` stay `NULL` until `completeMatch`/`forfeitMatch` run
`closeMatchScopedPositions`, so every UI reading those two columns shows a
frozen `0.00%` for the full duration of an ACTIVE match.

## 0. Recon correction — three stale surfaces exist today, not two

The task brief frames this as two consumers ("toolbar indicator" + Arena's
`LiveMatchView`). Reading the actual code turned up that **the toolbar
indicator already exists** — it just doesn't work:

| # | Location | What it shows | Status |
|---|---|---|---|
| 1 | `TradingPage.tsx:1287-1314` — the "Competition bottom bar" (absolute-positioned, full-width, bottom of `/trade`) | `⚔ 1V1  YOU: +0.00%  OPPONENT: +0.00%  TIME: 3H 12M` | **Already built**, reads `activeMatch.challenger_pnl_pct`/`opponent_pnl_pct` straight off the stale match row |
| 2 | `LiveMatchView.tsx` → `MatchHeaderBar` (`yourPnl`/`opponentPnl` props, `TradingPage.tsx` equivalent for Arena's own trade view) | Same two numbers, Arena's header bar | Same staleness — reads `match.challenger_pnl_pct`/`opponent_pnl_pct` from component state, only patched by the `match.ended` SSE push |
| 3 | `ArenaPage.tsx:436-455` (`ar-match-card` PnL row, lobby view) | Same two numbers, Arena lobby "MATCH LIVE" card | **Dead code for this purpose** — `ArenaPage` returns `<LiveMatchView>` early (line 322) whenever `activeMatch.status === "ACTIVE"`, so the lobby's own `tab === "1V1"` JSX (including this card) can only ever render for `status === "PENDING"`, which has no PnL yet. Not a live consumer — no fix needed here. |

**Net scope: two real fixes, not "one new UI + one existing-component fix."**
Both are wiring changes to already-built UI — feed both live data instead of
the frozen match-row snapshot. No new toolbar component is needed; item 5 in
the task brief ("design the toolbar indicator itself... minimal footprint")
is already satisfied by the existing bottom bar, so that design question is
answered as "fix in place," not "build new."

## 1. New event: `match.pnl.update`

Added to `apps/api/src/events/eventTypes.ts` (the live SSE backbone — not
`apps/api/src/eventStream/eventTypes.ts`, which is the unrelated dropped
audit-log event stream from the removed risk/governance subsystem, migration
059).

```ts
export interface MatchPnlUpdateData {
  matchId: string;
  challengerPnlPct: string;   // decimal string, same format as matches.challenger_pnl_pct
  opponentPnlPct: string;
}
```

Payload is intentionally the two PnL numbers only — both consumers
(bottom bar, `MatchHeaderBar`) already know which side is "you" vs.
"opponent" from `match.challenger_id`/`opponent_id` they already hold, the
same derivation `TradingPage.tsx:1288` and `LiveMatchView.tsx:563` already
do today. No need to duplicate `userId`-keyed fields or re-send names/timer —
this event's only job is refreshing two numbers.

Published **twice per recompute, once per participant**, exactly like
`match.ended`'s `publishMatchEnded` pattern (`matchService.ts:78-105`):

```ts
publish(createEvent("match.pnl.update", data, { userId: match.challenger_id }));
publish(createEvent("match.pnl.update", data, { userId: match.opponent_id }));
```

This rides the existing per-user delivery path in `eventBus.ts` — no new
transport. Confirmed via `v1Events.ts:32` (`PAIR_SCOPED_EVENT_TYPES = new
Set(["price.tick", "candle.closed"])`) that every other event type,
including this new one, **bypasses the per-connection pair interest-set
filter entirely** — so a spectating user's stream delivers this event
regardless of which pair they currently have selected on their own chart.
This directly answers task item 3/7's scope question: delivery is
independent of the viewer's selected pair.

## 2. Push mechanism — new module, `price.tick` subscriber

New file `apps/api/src/competitions/matchPnlEngine.ts`, sibling to
`alertEngine.ts`/`triggerEngine.ts`, same `subscribeGlobal(handler)` +
`startXEngine()`/`stopXEngine()` bootstrap shape.

**Query pattern: live DB query per tick, not an in-memory index.** The
codebase already has both patterns in production and explicitly documents
the tradeoff (`alertEngine.ts:28-31`'s comment on why it departs from
`triggerEngine.ts`). This picks `triggerEngine.ts`'s live-query style:

- Match volume is tiny today (CLAUDE.md's own "Top of mind": *"current user
  load is tiny"*) — there is no hot-path cost problem to solve yet.
- `idx_positions_user_match_open` (migration 066) is already a **partial**
  index — `WHERE base_qty <> 0 AND match_id IS NOT NULL` — so the row count
  it scans is bounded by "currently-open match-scoped positions across the
  whole platform," not table size. At today's volume that's realistically
  0-10 rows.
- An in-memory index (alertEngine's style) would need invalidation on
  match start/end AND on every position open/close/flip within a match —
  more moving parts, more places to introduce a staleness bug, for a
  dataset this small. Not worth it at current scale; flagging as a revisit
  if match volume ever grows enough for load-testing to flag this query.

On each `price.tick` for `pairId`:

```sql
SELECT DISTINCT match_id FROM positions
WHERE pair_id = $1 AND base_qty <> 0 AND match_id IS NOT NULL
```

(Uses `idx_positions_user_match_open` for the `base_qty <> 0 AND match_id
IS NOT NULL` predicate; `pair_id` is a residual filter over that already-tiny
row set — no new index needed.)

For each matched `match_id` still `status = 'ACTIVE'`, recompute **both**
participants' full `pnlPct` — across *all* pairs they hold in that match,
not just the ticked pair, since a player's total match PnL is the sum over
every position row they have in the match.

**Reuses the existing formula, doesn't reinvent it** — combines two pieces
already in `matchService.ts`:

1. Per-row unrealized PnL, identical to `closeMatchScopedPositions`'s formula
   (`matchService.ts:881-886`): `pnl = base_qty * (currentPrice - avg_entry_price)`
   for rows with `base_qty <> 0`; `0` for flat rows.
2. Aggregation + pct conversion, identical to `calculatePlayerStats`
   (`matchService.ts:743-752`): sum `(realized_pnl_quote - fees_paid_quote)`
   across all the user's rows in the match, add the unrealized term from (1),
   divide by `matches.starting_capital`, `× 100`.

New pure function `computeLiveMatchPnl(positions, priceByPair)` factors this
out of `matchService.ts` (both `closeMatchScopedPositions` and the new engine
call it — `closeMatchScopedPositions`'s per-row loop becomes a thin wrapper
that also books the result, so the formula lives in exactly one place).
Directly unit-testable, mirroring the `shouldFireAlert`/`shouldTrigger` pure-
function convention.

**Current price per pair**: `getSnapshot(symbol, 60_000)` — same store, same
staleness window `closeMatchScopedPositions` already uses for its exit-price
fallback (confirms task item 3: yes, populated independent of the viewer's
selected pair — `snapshotStore` is keyed by symbol globally, written by
`krakenWs.ts`/`coinbaseWs.ts` regardless of who's watching). If a position's
pair has no fresh snapshot (>60s stale — shouldn't happen for a pair that
just ticked, but a defensive fallback), fall back to `trading_pairs.last_price`,
same chain as the force-close fallback; never reach the `avg_entry_price`
(flat-close) tier live since that tier means "no live price at all," which
would mean don't publish this recompute rather than show a fake-flat PnL.

**Flood control — two gates, both reusing existing codebase conventions**
(the task asks for "a sensible threshold or minimum interval... similar in
spirit to" the book-channel 94%-noise finding):

1. **Minimum-change gate: 0.01 percentage points**, on *either* side's
   `pnlPct`. This is not a new number — it's the exact `minDelta` `usePnlFlash`
   (`apps/web/src/hooks/usePnlFlash.ts:30`) already uses to decide "is this
   PnL change worth flashing," reused server-side so the publish gate and
   the client's own flash-worthiness threshold agree.
2. **Minimum publish interval: 1000ms per match**, mirroring
   `LIVE_INDICATOR_THROTTLE_MS` (`CandlestickChart.tsx:126`) — the
   established "recompute-on-tick, throttle to ~1/sec" convention already
   used for RSI/MACD/ATR live-update. A `Map<matchId, { lastPublishedAt,
   lastChallengerPnl, lastOpponentPnl }>` in the module tracks both gates
   per match (small, self-cleans on `match.ended`).

Both gates must pass (changed enough AND due for a publish) before calling
`publish()`. A match with no qualifying tick for a while simply doesn't
publish — no heartbeat needed, since both consumers already have their own
slow-poll safety nets (`TradingPage`'s existing 30s match poll via
`useCompetitionMode`, `LiveMatchView`'s existing `syncMatchState` 30s poll) to
catch a missed push, exactly like `match.ended` already relies on for its own
fast-path/safety-net split.

Wired into `app.ts`'s boot sequence next to `startAlertEngine()`/
`startTriggerEngine()`; `stopMatchPnlEngine()` added to the shutdown path the
same way.

## 3. Scope: real matches only

`positions.match_id` only ever points at rows in the `matches` table (1v1
competitive matches, migration 057/066) — there is no separate demo/practice
match concept sharing this column. Stage 6 replay's `match_positions` table
(deprecated, seed-only) is unrelated and untouched — replay is post-match
reconstruction from candles, not a live feed. Solo `/replay` (historical
candle practice, `replay_sessions`) is a fully separate subsystem with its
own `replay.tick` event, also untouched. Confirmed no scope overlap.

## 4. Shared "active match" state — new store, not a bigger poll

Recon confirmed: `useCompetitionMode.ts` is hook-local state, independently
instantiated (independent poll timer, independent `activeMatch` state) at
two call sites — `useThemeDetector.ts` and `TradingPage.tsx`. Neither
consumer needs to change *how* the match is fetched, just needs the result
to be shared.

**New `apps/web/src/stores/activeMatchStore.ts`** (zustand, same shape as
`useCompetitionStore` but a distinct store — deliberately NOT folded into
`useCompetitionStore`, since that store is the *weekly-competition* tier
system, already flagged in `docs/followups.md` as a different, incompatible
vocabulary from the 1v1 match/ELO system; conflating them would be a second
instance of that exact confusion):

```ts
interface ActiveMatchState {
  activeMatch: Match | null;
  isInCompetition: boolean;       // derived: activeMatch?.status === "ACTIVE"
  setActiveMatch: (m: Match | null) => void;
  refreshMatch: () => Promise<void>;
}
```

`useCompetitionMode` becomes a thin wrapper: one `useEffect` (mount + 30s
poll, unchanged cadence and gating on `isAuthenticated`) that calls
`refreshMatch()`, reading state from the store instead of local `useState`.
Both existing call sites (`useThemeDetector`, `TradingPage`) keep calling
`useCompetitionMode()` with an unchanged return shape — zero call-site
diff, only the hook's internals move to a shared store. This satisfies task
item 4's "expose a shared active-match value other components can read"
without duplicating the poll (only one `setInterval` actually needs to run;
since both current call sites already mount together on `/trade`, the second
`useCompetitionMode()` call becomes a no-op subscribe rather than a second
timer — implementation detail: guard the interval-start with a module-level
"already polling" flag, same spirit as `alertEngine.ts`'s `if (handler)
return` idempotency guard).

The bottom-bar fix and `MatchHeaderBar` fix are the actual `match.pnl.update`
consumers; the store's job is only to answer "is there an active match at
all" (unchanged data source, REST poll) — the *PnL numbers themselves* come
from the new SSE event, patched into local component state exactly like
`match.ended` already patches `MatchEndedEvent` fields into `LiveMatchView`'s
`match` state (`LiveMatchView.tsx:615-632`).

## 5. Toolbar / bottom-bar fix (`TradingPage.tsx`)

Contained change: add a `sse:match.pnl.update` listener alongside the
existing SSE listeners in this file, patch two local fields instead of
reading `activeMatch.challenger_pnl_pct`/`opponent_pnl_pct` directly.

```ts
const [livePnl, setLivePnl] = useState<{ challengerPnlPct: string; opponentPnlPct: string } | null>(null);

useEffect(() => {
  const handler = (e: Event) => {
    const d = (e as CustomEvent<MatchPnlUpdateEvent>).detail;
    if (!d || !activeMatch || d.matchId !== activeMatch.id) return;
    setLivePnl({ challengerPnlPct: d.challengerPnlPct, opponentPnlPct: d.opponentPnlPct });
  };
  window.addEventListener("sse:match.pnl.update", handler);
  return () => window.removeEventListener("sse:match.pnl.update", handler);
}, [activeMatch]);
```

`yourPnl`/`oppPnl` at line 1289-1290 read `livePnl ?? activeMatch` (fall back
to the match-row snapshot until the first live push arrives, or if the match
just started and no qualifying tick has landed yet — same "static until
first update" behavior the rest of the app already tolerates). Reset
`livePnl` to `null` when `activeMatch` changes (new match / match ends) so a
stale number from a prior match can't leak, same reset-on-context-switch
discipline `usePnlFlash` already uses for its own baseline.

## 6. `LiveMatchView.tsx` fix

Same pattern, contained to this one component. Add a `sse:match.pnl.update`
listener next to the existing `sse:match.ended` one (`LiveMatchView.tsx:615-
632`), patch `match.challenger_pnl_pct`/`opponent_pnl_pct` in the existing
`setMatch` state updater:

```ts
useEffect(() => {
  const handler = (e: Event) => {
    const d = (e as CustomEvent<MatchPnlUpdateEvent>).detail;
    if (!d || d.matchId !== match.id || !isMounted.current) return;
    setMatch((prev) => ({
      ...prev,
      challenger_pnl_pct: d.challengerPnlPct,
      opponent_pnl_pct: d.opponentPnlPct,
    }));
  };
  window.addEventListener("sse:match.pnl.update", handler);
  return () => window.removeEventListener("sse:match.pnl.update", handler);
}, [match.id]);
```

`yourPnl`/`opponentPnl` (line 566-567) already derive from `match.*_pnl_pct`
— no change needed downstream of `setMatch`, since they read off the same
state object `match.ended` already patches. This is exactly the contained,
one-component data-source swap task item 6 asked for confirmation on.

## 7. Frontend event plumbing (mechanical, mirrors every existing event type)

- `apps/api/src/events/eventTypes.ts` — add `MatchPnlUpdateData` +
  `AppEvent` union member (§1).
- `apps/web/src/types/api.ts` — add `MatchPnlUpdateEvent` interface +
  `SSEEvent` union member, mirroring `MatchEndedEvent`.
- `apps/web/src/api/sse.ts` — add `onMatchPnlUpdate?:` handler slot to
  `SSEHandlers`, add `case "match.pnl.update":` dispatch.
- `apps/web/src/hooks/useSSE.ts` — add `onMatchPnlUpdate` handler that does
  `window.dispatchEvent(new CustomEvent("sse:match.pnl.update", { detail:
  event.data }))`, same one-liner every other passthrough event uses.

## Open questions for sign-off

1. **Confirm no new toolbar UI is needed** (§0) — the "toolbar indicator" the
   task described already exists as `TradingPage`'s Competition bottom bar;
   recommendation is to fix it in place rather than add a second, separate
   badge. If a *second*, more minimal always-visible badge is still wanted
   in `TradeToolbar.tsx` itself (distinct from the full-width bottom bar),
   that's additional scope beyond "fix the two stale surfaces" — flag if so.
2. **`ArenaPage.tsx`'s lobby match card PnL row is dead code for ACTIVE
   matches** (§0, item 3) — confirmed unreachable given the early return to
   `LiveMatchView`. No fix planned there; flagging in case there's a reason
   to keep it live (e.g. a future "spectate" mode that doesn't redirect).
3. **Query-per-tick vs. in-memory index** (§2) — recommending live-query
   (triggerEngine-style) over an index (alertEngine-style) given today's
   tiny match volume. Confirm, or flag if load-testing priorities (CLAUDE.md's
   "Next focus: scaling/observability") mean this should be built index-style
   from the start.
4. **Thresholds reused from existing conventions** (§2): 0.01pp minimum
   change (matches `usePnlFlash`), 1000ms minimum interval (matches
   `LIVE_INDICATOR_THROTTLE_MS`). Flagging as a deliberate reuse-not-
   reinvent choice, not a new number to bikeshed.
