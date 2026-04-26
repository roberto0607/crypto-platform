# Phase 9 — Match-Scoped Positions Rollout Plan

This document covers the production deploy of the match-scoping change set
(commits introducing migration 066, the fill-pipeline scope threading,
match-end close logic, the `/positions` filter, and supporting tests).

**Read end-to-end before running anything.** The migration and the code
deploy must land together — old code against the new schema breaks
order placement.

---

## Pre-flight checklist

- [ ] Local test suite passes (`260 / 260`).
- [ ] Local smoke completes (`apps/api/src/scripts/smoke-match-lifecycle.ts`).
- [ ] Latest prod backup taken within the last 24 h
      (`~/tradr-backups/prod-YYYYMMDD-HHMMSS.sql.gz`,
      verified ≥ 100 KB and contains > 0 `CREATE TABLE` lines).
- [ ] No active matches in flight at deploy time
      (run `SELECT count(*) FROM matches WHERE status = 'ACTIVE'` — if non-zero,
      consider a brief scheduled window or accept that affected users will
      see their in-flight position close at deploy time via the new logic).
- [ ] `railway link` is bound to `amusing-rejoicing / production / Postgres`.
- [ ] `railway whoami` reports the project owner account.

---

## Why migration order matters

Migration 066:

```sql
DROP INDEX IF EXISTS positions_user_pair_comp_unique;
CREATE UNIQUE INDEX IF NOT EXISTS positions_user_pair_scope_unique ...
```

Pre-refactor code's `ON CONFLICT (user_id, pair_id, COALESCE(competition_id, nil))`
clauses fail once that 3-column index is dropped — Postgres requires the
target tuple to match an existing unique index. We hit this in the Phase 2
local validation: 14 `tests/trading.test.ts` cases failed with
`HTTP 500 instead of 201` until the paired code was deployed.

**Therefore: migration and code must deploy as a single Railway release**,
either by:

- (a) including the migration in the same image build that runs it at boot
      via `RUN_MIGRATIONS_ON_BOOT=true`, OR
- (b) sequencing: take a brief maintenance window → run migration manually →
      deploy new code → end maintenance.

Option (a) is preferred — atomic from the application's perspective.

---

## Deploy order

### Step 1. Push the branch and confirm CI green

```bash
git push origin main
```

Watch GitHub Actions / Railway build pipeline. **Don't proceed if any
step shows red.**

### Step 2. Verify required env vars on the API service

Run this guard locally before pushing. It exits non-zero on any
missing or wrong-valued var:

```bash
# Pre-flight: required env vars on crypto-platform.
# MUST exit non-zero if any var is missing or wrong-valued.
# Passive checks were skipped during the April 25 phase 9
# push and caused a boot crashloop. See postmortem at the
# bottom of this doc.

REQUIRED_VARS=(
  DATABASE_URL
  JWT_ACCESS_SECRET
  RUN_MIGRATIONS_ON_BOOT
  NODE_ENV
  REDIS_URL
  CORS_ORIGINS
)

VARS_OUTPUT=$(railway variables --service crypto-platform 2>&1)
MISSING=()
for VAR in "${REQUIRED_VARS[@]}"; do
  echo "$VARS_OUTPUT" | grep -qE "\b${VAR}\b" \
    || MISSING+=("$VAR")
done
if [ ${#MISSING[@]} -gt 0 ]; then
  echo "MISSING ENV VARS on crypto-platform: ${MISSING[*]}"
  echo "Set via: railway variables --set 'KEY=value' --service crypto-platform"
  exit 1
fi

# Strict-value checks — catches "set but wrong" cases that
# presence checks miss. Each check below corresponds to a
# historically-painful bug class.

# 1. RUN_MIGRATIONS_ON_BOOT must be "true" (not "false", not
#    unset-defaulting-to-false). The April 25 incident was a
#    silent default-to-false.
if ! echo "$VARS_OUTPUT" | grep -qE "RUN_MIGRATIONS_ON_BOOT[[:space:]]+│[[:space:]]+true"; then
  echo "RUN_MIGRATIONS_ON_BOOT must equal 'true' (not just present)."
  exit 1
fi

# 2. NODE_ENV must be "production". Without this, sameSite
#    cookies are misconfigured (lax + insecure) and Swagger
#    UI is exposed. See CLAUDE.md history: "sameSite cookie
#    fix (none in prod)".
if ! echo "$VARS_OUTPUT" | grep -qE "NODE_ENV[[:space:]]+│[[:space:]]+production"; then
  echo "NODE_ENV must equal 'production' for the prod deploy."
  exit 1
fi

# 3. CORS_ORIGINS must contain a *.railway.app origin (the
#    deployed frontend). Catches "set to localhost only"
#    misconfigs. Pattern is intentionally loose so service
#    renames don't silently break this check; tighten if you
#    later add a custom domain.
if ! echo "$VARS_OUTPUT" | grep -qE "CORS_ORIGINS[[:space:]]+│[[:space:]]+.*railway\.app"; then
  echo "CORS_ORIGINS must include a *.railway.app origin."
  exit 1
fi

echo "All required env vars present and correctly valued on crypto-platform."
```

The box-drawing `│` characters in the strict-value regexes match the
Unicode separator (`U+2502`) that `railway variables` prints between
the variable name and value columns. If `railway` ever changes its
output format, the strict checks will start failing — update the
regexes rather than weakening them to a presence-only match.

### Step 3. Deploy

Railway auto-deploys on push to `main`. Watch the deploy log:

```bash
railway logs --service crypto-platform
```

Expected sequence on boot:

```
[migrationGuard] Advisory migration lock acquired.
Applied 066_position_match_scope.sql
[migrationGuard] Schema OK — code=066_position_match_scope.sql db=066_position_match_scope.sql
... (server start)
```

If you see `[migrationGuard] FATAL: DB is behind code` for >30 seconds,
the migration didn't run. Stop and investigate before traffic flips.

---

## Verification

Run all four after the deploy completes:

### V1. Schema applied

```bash
railway run bash -c 'psql "$DATABASE_PUBLIC_URL" -c "\d positions"'
```

Expected:
- `match_id` column present
- `positions_user_pair_scope_unique` 4-col unique index
- `idx_positions_user_match_open` partial index
- `positions_match_fk` constraint with `ON DELETE SET NULL`

### V2. `/v1/matches/active` returns 200

```bash
curl -s -i -H "Authorization: Bearer $TOKEN" \
  https://crypto-platform-production-691d.up.railway.app/v1/matches/active
```

Expect `200 OK` with `{ ok: true, match: ... }` or `{ ok: true, match: null }`.
A 500 here means the new server is up but match service is broken.

### V3. Place a test order while not in a match → free-play scope

As any user not currently in a match:

```bash
curl -s -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: rollout-test-$(date +%s)" \
  -d '{"pairId":"<some-pair-id>","side":"BUY","type":"MARKET","qty":"0.0001"}' \
  https://crypto-platform-production-691d.up.railway.app/orders
```

Then:

```bash
railway run bash -c 'psql "$DATABASE_PUBLIC_URL" -c \
  "SELECT user_id, base_qty, match_id, competition_id FROM positions WHERE user_id = '\''<test-user-id>'\''"'
```

Expect: row(s) with `match_id IS NULL`. Confirms free-play attribution.

### V4. Active match → fill attributes to match

If a user is currently in an ACTIVE match, place an order via the same
flow and observe:

```sql
SELECT user_id, pair_id, base_qty, match_id, competition_id
FROM positions
WHERE user_id = '<user>' AND match_id IS NOT NULL;
```

Expect a row with `match_id = <their match.id>`.

---

## Verification — outstanding items

### V4 (in-match order attribution) — deferred to dad-test 1v1

Status as of 2026-04-25: deferred (not failed).

V4 requires an in-match fill to validate. At deploy time there were 0
active matches in production and demo was not paired against any user,
so V4 returned an N/A per this doc's sign-off allowance. V2
(active-match endpoint), V3 (free-play scope), and V1 (schema +
indexes) all passed cleanly, so the new code path is live but not yet
exercised end-to-end on real match traffic.

**Resolution path: weekend dad-test 1v1.**

Acceptance criteria — V4 is closed when all of the following are
observed in production:

1. Two real users (rtirado0607@gmail.com + demo@demo.local on dad's
   browser) start a 1v1 match
2. Each places at least one filled order during the match
3. While match is active, query confirms positions have `match_id` set
   to the active match UUID:

   ```sql
   SELECT user_id, base_qty, match_id, updated_at
   FROM positions
   WHERE match_id IS NOT NULL
   ORDER BY updated_at DESC LIMIT 10;
   ```
4. Match resolves cleanly (winner, ELO delta applied, `elo_resolved=true`)
5. Both users start a NEW 1v1 immediately after; query confirms NO
   leftover position rows from the prior match leak into the new
   context — i.e. no positions with `base_qty <> 0` and a stale
   `match_id` from the completed match
6. Capture DB query output as evidence; record it in this doc's
   verification log

Until all 6 are observed, phase 9 is "verified-with-caveat" rather
than "verified-complete".

---

## Rollback

The migration is **forward-only** — there is no built-in `down` step.
If the deploy goes wrong:

### Code rollback (preferred, tries to keep the schema)

```bash
git revert <hash-of-commit-3>..HEAD
git push origin main
```

The reverted code will still run against the migrated schema as long as
**all 4-col `ON CONFLICT` targets remain compatible** with the new index.
This is the case post-migration — the new index is strictly wider, and
COALESCE-nil makes the 3-col-target write fail (no longer an index match).

**This means a partial code rollback won't actually work** — the old code
will hit the same `HTTP 500` problem we caught in Phase 2. So plan for full
schema-and-code rollback if anything breaks.

### Schema rollback (manual SQL — destructive to match-scoped data)

Only if you must restore the pre-066 schema:

```sql
-- Inverse of migration 066. Execute against $DATABASE_PUBLIC_URL.
-- WARNING: any rows already written with non-NULL match_id will lose
--          their scope attribution.

ALTER TABLE positions DROP CONSTRAINT IF EXISTS positions_match_fk;
DROP INDEX IF EXISTS positions_user_pair_scope_unique;
DROP INDEX IF EXISTS idx_positions_user_match_open;
ALTER TABLE positions DROP COLUMN IF EXISTS match_id;
CREATE UNIQUE INDEX IF NOT EXISTS positions_user_pair_comp_unique
    ON positions(user_id, pair_id,
                 COALESCE(competition_id, '00000000-0000-0000-0000-000000000000'::uuid));

ALTER TABLE wallets DROP CONSTRAINT IF EXISTS wallets_match_fk;
DROP INDEX IF EXISTS wallets_user_asset_scope_unique;
ALTER TABLE wallets DROP COLUMN IF EXISTS match_id;
CREATE UNIQUE INDEX IF NOT EXISTS wallets_user_asset_comp_unique
    ON wallets(user_id, asset_id,
               COALESCE(competition_id, '00000000-0000-0000-0000-000000000000'::uuid));

ALTER TABLE equity_snapshots DROP CONSTRAINT IF EXISTS equity_snapshots_match_fk;
DROP INDEX IF EXISTS equity_snapshots_user_ts_scope_unique;
ALTER TABLE equity_snapshots DROP COLUMN IF EXISTS match_id;
CREATE UNIQUE INDEX IF NOT EXISTS equity_snapshots_user_ts_comp_unique
    ON equity_snapshots(user_id, ts,
                        COALESCE(competition_id, '00000000-0000-0000-0000-000000000000'::uuid));

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_match_fk;
DROP INDEX IF EXISTS idx_orders_match;
ALTER TABLE orders DROP COLUMN IF EXISTS match_id;

DELETE FROM schema_migrations WHERE id = '066_position_match_scope.sql';
```

Then `git revert` the four `feat:` commits and re-deploy.

If that still fails, restore from the pre-flight backup:

```bash
gunzip -c ~/tradr-backups/prod-YYYYMMDD-HHMMSS.sql.gz | \
  railway run bash -c 'psql "$DATABASE_PUBLIC_URL"'
```

---

## Known limitations

### The Apr 1 ghost position is NOT cleaned up by this deploy

User `338d993f-0444-4a0a-b463-d3cb6ce0d959` has an open `-0.29119181 BTC`
short with `match_id IS NULL` and `competition_id IS NULL`, dated
2026-04-01. This is the original pre-fix ghost.

**This deploy does not touch it.** The new code prevents *future* ghosts
but does not retroactively close existing ones. The user (Roberto)
chose to close it manually via the UI's "Close Position" button after
deploy rather than ship a cleanup script in this PR. The `/positions`
endpoint will surface it under free-play (the user is not in a match),
and clicking "Close" will route through the now-correct fill pipeline.

If for some reason the UI close path doesn't work, manual SQL fallback:

```sql
UPDATE positions
SET base_qty = 0,
    avg_entry_price = 0,
    realized_pnl_quote = realized_pnl_quote
                       + ((SELECT last_price::numeric FROM trading_pairs
                           WHERE id = pair_id) - avg_entry_price) * base_qty,
    updated_at = now()
WHERE user_id = '338d993f-0444-4a0a-b463-d3cb6ce0d959'
  AND base_qty <> 0
  AND match_id IS NULL
  AND competition_id IS NULL;
```

(Run that only after deploy, only if the UI close fails.)

### `match_positions` table is now dead

Phase 5 swapped both `completeMatch` and `forfeitMatch` to the new
`closeMatchScopedPositions`. The old `forceCloseOpenPositions` function
is marked `DEPRECATED` and the `match_positions` table is no longer
written to by the live pipeline. Cleanup migration is deferred to a
future PR — leaving the table in place adds zero risk.

### Wallets are still free-play scoped

Migration 066 added `wallets.match_id`, but Phase 4–6 did not thread
match scoping through wallet lookups. Position scoping uses match_id;
wallets remain on the competition_id scope only. This is intentional —
the user's actual money flow stays on the free-play wallet, and match
P&L is tracked separately on the match-scoped position row. Worth
revisiting if we add match-isolated balances.

### Journal stays competition-scoped

`open_lots` and `closed_trades` don't have `match_id` columns. The fill
pipeline accepts a `matchId` param but doesn't pass it to
`processFillForJournal`. Journal P&L for match-scoped fills falls into
the user's general `competition_id IS NULL` journal. Acceptable for now —
the match's authoritative P&L source is `positions.realized_pnl_quote`.

### Frontend dead code

`DashboardPage`, `PortfolioPage`, `PositionsPage` exist in the repo
but aren't routable (App.tsx redirects their paths to `/trade`). Their
analytics endpoint calls (`getPnlSummary`, `getEquity`, `getStats` in
`apps/web/src/api/endpoints/analytics.ts`) point at URLs the backend
doesn't expose. Not blocking — flagged for a future cleanup PR.

---

## Sign-off checklist

After the deploy:

- [ ] V1 — schema verification passed
- [ ] V2 — `/v1/matches/active` returns 200
- [ ] V3 — free-play order attributes correctly
- [ ] V4 — in-match order attributes correctly (or no test user is in a match)
- [ ] Roberto's Apr 1 ghost position closed via UI (verify with `SELECT
      ... FROM positions WHERE user_id = '338d993f-...' AND base_qty <> 0`)
- [ ] No new errors in `railway logs --service crypto-platform`
      relating to `ON CONFLICT`, `positions_user_pair`, or
      `match_id`.

If all six are green, the deploy is complete.

---

## Postmortem — 2026-04-25

**Incident:** Boot crashloop after pushing 7 commits (migration 066)
to production.

**Detection:** Migration guard FATAL line in Railway logs:

> `[migrationGuard] FATAL: DB is behind code. Run 'pnpm migrate'.
> code=066_position_match_scope.sql db=065_footprint_candles.sql`

This is the guard working as designed — it refuses boot when code
expects a migration the DB hasn't applied.

**Root cause:** `RUN_MIGRATIONS_ON_BOOT` was not set on the
crypto-platform service. The boot sequence skipped the migration step
and went straight to the guard, which correctly refused.

**Why pre-flight missed it:** This doc previously said "verify env vars
are set" without an executable check. The verification was performed
visually and the missing var was not noticed.

**Recovery:**

- Old container kept serving traffic (Railway didn't flip until new
  deploy reached SUCCESS, which it never did)
- Set `RUN_MIGRATIONS_ON_BOOT=true` via `railway variables --set`
- Auto-triggered redeploy applied migration 066 cleanly on next boot
  (~52s build + ~7s deploy)
- Total time from crashloop to recovered: ~12 minutes
- Pre-flight backup at
  `~/tradr-backups/tradr-prod-pre-phase9-20260425T131511Z.dump` was
  not needed but remained available throughout

**Prevention:** Pre-flight env-var check is now executable (see
"Pre-flight Step 2" above). Future rollouts MUST fail-loud on missing
required vars before push.
