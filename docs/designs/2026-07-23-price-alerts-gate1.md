# Gate 1 Design — Price Alerts

Status: design lock, no Gate 2 implementation yet. Builds on Gate 0 recon
(email infra, eventBus/price.tick pipeline, requireVerified gating, frontend
toolbar hook point — see prior conversation turn, not re-derived here).

## 1. Metric addition + real tick-rate measurement (done as part of this gate)

Added `eventsPublishedTotal.inc({ type: "price.tick" })` in
`krakenWs.ts`'s `handleTickerMessage`, right after the existing
`publish(createEvent("price.tick", ...))` call — one line, same try/catch
scope so a metrics failure still can't break the feed. Typechecked clean
(`npx tsc --noEmit`), picked up by the running `tsx watch` dev server without
a manual restart.

**Measured locally**: 497 `price.tick` events over 291s wall-clock, against
the live Kraken WS feed (confirmed connected via `/health`) across the full
~75-pair curated universe.

**Real rate: ~1.7 ticks/sec system-wide.**

This is well below Gate 0's rough estimate ("low tens/sec") — actual crypto
market tick volume across this pair set is low-single-digits per second on
average, dominated by whichever majors have active order flow at a given
moment. `triggerEngine.ts` already does a full DB round-trip
(`listActiveTriggersForPair`, one query per pair per tick) at this same
volume with no reported issue, so:

- **The naive "evaluate every active alert per tick" approach is safe as-is.**
  No batching, sampling, or index-sharding strategy is needed at current
  scale.
- The in-memory index (section 3) is still the right call — not because
  1.7/sec demands it, but because it avoids a DB round-trip on the hot path
  entirely and keeps the alert engine architecturally independent of DB
  latency spikes. It's a quality choice, not a scale necessity, at today's
  volume.
- If pair count or user count grows an order of magnitude (750 pairs, or
  much higher per-pair trade frequency from real liquidity), re-measure
  before assuming this still holds — the metric is now wired permanently via
  `events_published_total{type="price.tick"}`, so future Gate audits can
  just read `/metrics` instead of re-instrumenting.

## 2. Schema — `alerts` table

Modeled directly on `trigger_orders` (migration `017_trigger_orders.sql` +
`064_trailing_stop.sql`) for consistency: same ID/timestamps/status
conventions, same `(pair_id, status)` and `(user_id, status)` index shape.

New migration: `073_price_alerts.sql` (next number after
`072_candles_1w_timeframe.sql`).

```sql
CREATE TABLE alerts (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(id),
  pair_id           UUID NOT NULL REFERENCES trading_pairs(id),
  condition_type    TEXT NOT NULL CHECK (condition_type IN (
                      'PRICE', 'CROSSING', 'CROSSING_UP', 'CROSSING_DOWN'
                    )),
  target_value      NUMERIC(28,8) NOT NULL,
  frequency         TEXT NOT NULL CHECK (frequency IN ('ONCE', 'EVERY_N_MINUTES')),
  frequency_minutes INTEGER CHECK (frequency_minutes IS NULL OR frequency_minutes > 0),
  last_fired_at     TIMESTAMPTZ,
  status            TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN (
                      'ACTIVE', 'FIRED', 'EXPIRED', 'CANCELLED'
                    )),
  expiration        TIMESTAMPTZ,
  message_template  TEXT,
  channels          JSONB NOT NULL DEFAULT '["email"]'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT alerts_frequency_minutes_check CHECK (
    (frequency = 'EVERY_N_MINUTES' AND frequency_minutes IS NOT NULL) OR
    (frequency = 'ONCE' AND frequency_minutes IS NULL)
  )
);

CREATE INDEX idx_alerts_pair_status ON alerts (pair_id, status);
CREATE INDEX idx_alerts_user_status ON alerts (user_id, status);

CREATE TRIGGER trg_alerts_updated
  BEFORE UPDATE ON alerts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
```

Deliberate deviations from `trigger_orders`, with reasoning:

- **`status` values differ** (`FIRED`/`CANCELLED` vs. triggers'
  `TRIGGERED`/`CANCELED`) — matches the feature spec's vocabulary
  (once-alerts terminate at `FIRED`; triggers terminate at `TRIGGERED`).
  Note the double-`L` spelling divergence (`CANCELLED` here vs. `CANCELED`
  in `trigger_orders`) is intentional to match the spec's British spelling
  in this ticket, but **flagged as a real risk of copy-paste bugs across the
  two tables** — worth a second look before Gate 2 locks it in (see Open
  Questions).
- **No `oco_group_id`, `derived_order_id`, `fail_reason`** — alerts don't
  place orders, so the OCO/derived-order machinery that `trigger_orders`
  needs doesn't apply here.
- **`channels JSONB` instead of an enum column** — per the spec's explicit
  ask, so SMS can be added later (`["email", "sms"]`) without a migration.
  Defaults to `["email"]`. The evaluation/firing logic (section 4) iterates
  this array and dispatches per-channel rather than assuming email.
- **`expiration` and `message_template`** — no `trigger_orders` analog;
  added per spec, both nullable (`expiration` unset = never expires,
  `message_template` unset = fall back to a default-generated message in
  section 5's template).
- **`frequency`/`frequency_minutes`/`last_fired_at`** — no `trigger_orders`
  analog (triggers always fire once). This is the new state class Gate 0
  flagged as having no reusable pattern in the codebase.

## 3. Evaluation engine — `alertEngine.ts`

New file: `apps/api/src/alerts/alertEngine.ts`, alongside
`apps/api/src/alerts/alertRepo.ts` and `alertTypes.ts` — same module layout
as `apps/api/src/triggers/`.

### In-memory index

```ts
type AlertRow = { /* mirrors the DB row, see alertTypes.ts */ };

const alertsByPair = new Map<string, AlertRow[]>();
const lastPriceByPair = new Map<string, number>(); // for crossing detection
```

**This is a deliberate departure from `triggerEngine.ts`**, which queries
`listActiveTriggersForPair` (a live `pool.query`) on every single tick —
worth being explicit about, since Gate 0's recon didn't flag this
distinction. The trigger engine's DB-per-tick approach works today because
trigger volume is low; this gate builds the in-memory index instead per the
spec's explicit ask, avoiding both the DB round-trip on the hot path and the
class of "trigger engine falls behind under DB load" risk entirely.

### Bootstrap (`startAlertEngine`)

1. Full load: `SELECT * FROM alerts WHERE status = 'ACTIVE'`, bucket into
   `alertsByPair` by `pair_id`.
2. `subscribeGlobal(handler)` on the eventBus, same as
   `triggerEngine.startTriggerEngine()`.
3. Handler reacts to:
   - `price.tick` → run evaluation (below) for that `pairId`, update
     `lastPriceByPair`.
   - **New internal event `alert.updated`** (added to `eventTypes.ts`'s
     `AppEvent` union, `{ alertId, pairId, action: "created" | "cancelled" | "expired" }`)
     → apply a targeted patch to `alertsByPair` (append on create, splice on
     cancel/expire) rather than a full reload. Published by the CRUD routes
     (section 6) alongside the DB write, riding the same Redis-mirrored
     eventBus that already keeps multi-instance state in sync for
     `price.tick`/`trigger.fired` — so this needs zero new infrastructure,
     just a new event type and a publish call at each mutation site.
4. **Periodic full resync** every `ALERT_INDEX_RESYNC_INTERVAL_MS` (proposed
   5 min, config-driven) as a self-healing safety net — mirrors
   `krakenWs.ts`'s `SYMBOL_REFRESH_INTERVAL_MS` pattern. Covers: an instance
   that missed an `alert.updated` event (e.g. it was mid-restart), and
   protects against any bug in the incremental-patch path silently drifting
   the index from the DB over time.

### Crossing detection

`condition_type = PRICE` only needs the current tick (`last >= target` or
`<=`, direction implied by spec as a simple threshold — confirm exact
semantics in Open Questions).

`CROSSING`/`CROSSING_UP`/`CROSSING_DOWN` need the **previous** tick's price
for that pair, not just the current one — a single tick above target tells
you nothing about whether the price just crossed or was already there.
`lastPriceByPair` (populated from the same `price.tick` stream, one entry
per `pairId`) supplies the "before" value:

```ts
function shouldFireAlert(alert: AlertRow, prevPrice: number | null, currentPrice: number): boolean {
  const target = parseFloat(alert.target_value);
  switch (alert.condition_type) {
    case "PRICE":
      return currentPrice >= target; // exact semantics: see Open Questions
    case "CROSSING":
      return prevPrice !== null && (
        (prevPrice < target && currentPrice >= target) ||
        (prevPrice > target && currentPrice <= target)
      );
    case "CROSSING_UP":
      return prevPrice !== null && prevPrice < target && currentPrice >= target;
    case "CROSSING_DOWN":
      return prevPrice !== null && prevPrice > target && currentPrice <= target;
  }
}
```

`prevPrice === null` (first tick this process has seen for that pair, e.g.
right after boot) means no crossing can be detected yet — correctly skipped,
not a false positive. This mirrors `shouldTrigger()`'s pure/testable shape in
`triggerEngine.ts` (same reason: deterministic given `(alert, prevPrice,
currentPrice)`, directly unit-testable without a live tick).

## 4. Firing logic

Two-path split by `frequency`, both inside `evaluateAlertsForPair`:

**`ONCE`**: on match, atomically flip `status` to `FIRED` — same two-phase
shape as `fireTrigger`'s `markTriggeredTx` (SELECT FOR UPDATE, confirm still
`ACTIVE`, UPDATE, all in one txn) so a race between two ticks landing
close together can't double-fire. New `alertRepo.ts` function
`markFiredTx(client, alertId)`, structurally identical to
`triggerRepo.ts`'s `markTriggeredTx`.

**`EVERY_N_MINUTES`**: on match, check
`last_fired_at IS NULL OR now() - last_fired_at >= frequency_minutes * interval '1 minute'`
before firing. On fire: `UPDATE alerts SET last_fired_at = now() WHERE id = $1`
— **status stays `ACTIVE`**, no terminal transition (per spec — only
`expiration` or explicit cancel ends a repeating alert). This check should
happen in the DB update's WHERE clause (not a separate SELECT-then-UPDATE)
to avoid a race where two ticks both read a stale `last_fired_at` and both
fire:

```sql
UPDATE alerts
SET last_fired_at = now()
WHERE id = $1
  AND status = 'ACTIVE'
  AND (last_fired_at IS NULL OR now() - last_fired_at >= (frequency_minutes || ' minutes')::interval)
RETURNING *;
```

If this returns 0 rows, another tick already claimed this firing window —
skip silently (same idempotency shape as `markTriggeredTx` returning `null`).

Both paths also need an **expiration check** before evaluation runs at all:
if `expiration IS NOT NULL AND now() > expiration`, flip `status = 'EXPIRED'`
and skip firing — this can piggyback on the same UPDATE...WHERE guard or run
as a cheap pre-filter when building `alertsByPair` (excluding expired rows
from the in-memory index is actually cleaner: a periodic sweep job, same
pattern as `apps/api/src/jobs/definitions/cleanupEmailTokensJob.ts`, marks
expired rows `EXPIRED` in the DB and the next `alert.updated`/resync removes
them from the index — avoids checking wall-clock time on every single tick
for every alert).

## 5. Email delivery

New `alertFiredEmail(pairSymbol, conditionType, targetValue, currentPrice, messageTemplate?)`
in `templates.ts`, alongside `verificationEmail`/`passwordResetEmail` —
same `{ subject, html }` return shape. Call `sendEmail(user.email, subject, html)`
directly (already generic, no changes needed to `emailTransport.ts`).

**Verification gate — independent of `requireVerified`, by design** (per
Gate 0 finding: that middleware early-returns on the global
`REQUIRE_EMAIL_VERIFICATION` flag, and alert firing isn't an HTTP request
context anyway). New standalone check inside the firing path:

```ts
const { rows } = await pool.query(
  "SELECT email, email_verified_at FROM users WHERE id = $1",
  [alert.user_id]
);
if (!rows[0]?.email_verified_at) {
  logger.warn({ userId: alert.user_id, alertId: alert.id }, "alert_fire_skipped_unverified_email");
  // do not send — see decision below on whether this should still count as "fired"
  return;
}
```

**Decision: unverified users CAN create alerts.** Blocking alert creation on
verification would be surprising (the user just configured a fully valid
alert) and inconsistent with how the rest of the platform treats
unverified users (verification currently gates nothing platform-wide by
default — `REQUIRE_EMAIL_VERIFICATION` defaults `false`). Instead:

- Alert creation succeeds regardless of verification state.
- **Frontend surfaces this explicitly** (not a silent no-op): if
  `!user.emailVerified` (already returned by `GET /auth/me`, per Gate 0),
  the alert creation panel shows an inline warning — "You'll need to verify
  your email before this alert can notify you" — with a resend-verification
  action, rather than letting the user believe the alert is fully live.
- **Backend logs + optionally still records a "fire" for cadence purposes**
  — open question below on whether a skipped-due-to-unverified `ONCE` alert
  should still flip to `FIRED` (consuming its one shot silently) or stay
  `ACTIVE` so it retries once the user verifies. Leaning toward: **stay
  ACTIVE, keep trying every tick** — cheap at 1.7 ticks/sec, and matches the
  "don't silently drop user intent" principle better than a burned one-shot
  alert with no email ever received.

## 6. API routes — `/v1/alerts`

New `apps/api/src/routes/v1/v1Alerts.ts`, registered in
`apps/api/src/routes/v1/index.ts` next to `v1Triggers` (`app.register(v1Alerts)`).
Structurally a direct port of `v1Triggers.ts`'s pattern: Zod parse +
duplicated Fastify JSON schema (CLAUDE.md's existing "Fastify JSON schema
must match Zod schema" gotcha applies identically here — same
`condition_type`/`frequency` enum values need to stay in sync in both
places), `requireUser` preHandler, `v1HandleError`.

- `POST /v1/alerts` — create. Body: `pairId`, `conditionType`,
  `targetValue`, `frequency`, `frequencyMinutes?`, `expiration?`,
  `messageTemplate?`, `channels?` (defaults `["email"]`). Zod `.refine()`
  enforces `frequency === "EVERY_N_MINUTES" ⟺ frequencyMinutes present`,
  mirroring `createTriggerBody`'s existing refine-per-kind shape.
- `GET /v1/alerts` — list, paginated, same cursor shape as
  `listTriggersByUser` (`(created_at, id)` keyset pagination via
  `decodeCursor`/`slicePage`). Filters: `pairId?`, `status?`.
- `DELETE /v1/alerts/:id` — cancel, same idempotent-ownership-checked shape
  as `cancelTriggerByUser` (atomic `UPDATE ... WHERE id=$1 AND user_id=$2 AND status='ACTIVE'`,
  fall back to existence check for the idempotent-already-cancelled case).
- No `PATCH`/update-in-place in v1 — matches triggers (no edit endpoint
  exists there either); "update" from the UI is cancel + recreate. Flagged
  in Open Questions since the spec listed "update" in the CRUD ask.

New `AppError` codes needed in `errors/AppError.ts`'s two maps:
`alert_not_found` (404), `alert_not_cancelable` (400) — same pattern as
`trigger_not_found`/`trigger_not_cancelable`.

Every create/cancel/expire mutation also publishes the new `alert.updated`
event (section 3) so all instances' in-memory indexes stay current.

## 7. Frontend — `AlertPanel`

New `apps/web/src/components/trading/AlertPanel.tsx`, wired to
`TradeToolbar.tsx`'s existing placeholder bell button (line 326) — replace
the bare `<button>` with the same local-state dropdown shape already used
three times in this file (search dropdown, timeframe picker) and in
`IndicatorToolbar.tsx`'s gear: `useState` for open/closed, `useRef` +
`mousedown` outside-click-close, `position: absolute` panel anchored under
the button. **No generic Modal component** — matches the existing
hand-rolled pattern rather than introducing new shared infrastructure.

Fields (per spec, matching the TradingView reference):

- Condition: fixed "Price" label (only one condition *category* exists —
  the dropdown below is what actually varies)
- Crossing / Crossing Up / Crossing Down / Price — dropdown mapping to
  `condition_type` (`PRICE` reuses this same dropdown as a 4th option per
  spec's framing, or is a separate toggle — see Open Questions, the exact
  TradingView layout groups "Price" as its own top-level condition
  vs. Crossing as a sub-group; worth confirming against the actual
  screenshots before Gate 2 build)
- Value — numeric input, `target_value`
- Trigger frequency — radio/select: "Once" vs. "Every N minutes" (reveals a
  minutes `<input type="number">` when the latter is selected)
- Expiration — date/time picker, optional
- Message — free-text, optional, maps to `message_template`
- Channel — for now, a disabled/checked "Email" checkbox (structurally a
  checklist against the `channels` array so adding SMS later is just
  un-disabling a second checkbox, no new form architecture)

Submit → `POST /v1/alerts`.

If `!user.emailVerified`, render the inline warning described in section 5
directly in this panel (not a separate modal) — keeps the "this alert won't
notify you yet" state visible at the point of creation.

## 8. Alert management (list/cancel)

Second tab or scroll-section within the same `AlertPanel` dropdown (matches
TradingView putting both in one surface, per spec) — not a separate route
or page. `GET /v1/alerts?status=ACTIVE` on panel open, render each as a row
(`pair symbol · condition · target · frequency`) with a cancel (×) button
calling `DELETE /v1/alerts/:id`, optimistically removed from the list on
success. Given the panel is already anchored to the toolbar and short-lived
(opens/closes per interaction, like the indicator gear), a full store
subscription isn't needed — local `useState` + fetch-on-open is consistent
with how `TradeToolbar.tsx`'s pair search already works (fetch-on-input,
not a global store).

## Open questions (resolve before Gate 2)

1. **`PRICE` condition exact semantics** — is it `>=`/`<=` based on a
   direction implied by current price vs. target (e.g. "fires when price
   reaches or exceeds target, direction inferred from target vs. current
   price at creation time"), or does the UI need an explicit up/down toggle
   for the plain "Price" condition the way stop/take-profit triggers use
   `side` to disambiguate? `trigger_orders` resolves this via `side` +
   `kind`; alerts have no `side` field in the current schema draft. Needs
   the actual TradingView screenshot semantics confirmed, not assumed.
2. **`CANCELLED` vs. `CANCELED` spelling divergence from `trigger_orders`**
   — intentional per this ticket's wording, but worth a deliberate
   yes/no before it ships, since it's an easy source of copy-paste bugs
   between the two nearly-identical modules.
3. **Should a `ONCE` alert skipped due to unverified email still consume its
   one shot?** Leaning "no, stay ACTIVE and retry" (section 5) but this is a
   product decision, not purely technical.
4. **No update/edit endpoint** — spec's CRUD list says "update"; this design
   follows the trigger_orders precedent of cancel+recreate only. Confirm
   that's acceptable before Gate 2, or scope a `PATCH /v1/alerts/:id`
   (likely limited to `target_value`/`expiration`/`message_template`/
   `frequency_minutes` — changing `condition_type` or `pair_id` probably
   should still require recreate).
5. **Alert volume ceiling** — no per-user cap on active alerts is designed
   here. At 1.7 ticks/sec system-wide this is cheap even with, say, a few
   hundred alerts per pair, but an unbounded-per-user cap could still be
   abused (e.g. thousands of alerts on one pair inflating the in-memory
   index and per-tick iteration cost). Worth a soft cap (e.g. 50 active
   alerts/user) enforced at the `POST /v1/alerts` layer — cheap insurance,
   not urgent given current scale.
6. **Multi-instance topology** — the in-memory index design assumes the
   existing Redis-mirrored eventBus keeps instances in sync via
   `alert.updated`. Confirm how many API instances actually run in
   production today (CLAUDE.md doesn't state a replica count) — if it's
   provably 1, the periodic-resync safety net matters less, but the design
   should stay correct either way rather than assuming single-instance.
