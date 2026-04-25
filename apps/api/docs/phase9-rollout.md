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

### Step 2. Verify `RUN_MIGRATIONS_ON_BOOT=true` on the API service

In Railway dashboard → `crypto-platform` service → Variables, confirm:

```
RUN_MIGRATIONS_ON_BOOT=true
```

If absent or `false`, set it to `true` *before* the next deploy so the
new container applies migration 066 during boot, before serving traffic.

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
