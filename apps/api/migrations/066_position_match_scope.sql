-- ============================================================
-- 066_position_match_scope.sql
-- Match-scoping for positions, wallets, equity_snapshots, orders.
-- ============================================================
--
-- Context:
--   1v1 matches (created in migration 057) introduced per-match competition
--   between two users. Positions, wallets, and equity snapshots are already
--   scoped to "competition" (see migration 042), but a match is NOT a
--   competition — matches live in their own `matches` table and have their
--   own lifecycle. Prior to this migration, an order placed while a match
--   was ACTIVE would mutate the user's global free-play position row and
--   then outlive the match itself, surfacing as a "ghost" position in
--   subsequent matches.
--
-- What this migration does:
--   * Adds a nullable `match_id UUID` column to positions, wallets,
--     equity_snapshots, and orders, with an FK to matches(id)
--     ON DELETE SET NULL. Deleting a match does NOT delete the position
--     history — we keep the record and just break the link, so audit
--     trail and historical PnL are preserved.
--   * Rebuilds the unique indexes on positions, wallets, and
--     equity_snapshots to include match_id. Uses the same COALESCE-nil-UUID
--     trick migration 042 established so NULL and (NULL, NULL) scopes each
--     collapse to a single "global free-play" row per (user, pair/asset).
--   * Adds a hot-path partial index for "open match-scoped positions"
--     so the match UI's position panel can filter quickly by active match.
--
-- What this migration does NOT do:
--   * Does NOT backfill existing rows — all production rows currently have
--     competition_id IS NULL and match_id will default to NULL (free play).
--   * Does NOT drop the dead match_positions table (separate cleanup TBD).
--   * Does NOT change any application behavior by itself — the code changes
--     in applyFillToPositionTx, placeOrderWithSnapshot, completeMatch, and
--     forfeitMatch ship alongside this migration and are what actually
--     wire match_id through the fill pipeline and close match-scoped
--     positions at match end.
--
-- Paired code changes (same PR):
--   - analytics/positionRepo.ts         : applyFillToPositionTx accepts matchId
--   - repair/positionRebuildService.ts  : ON CONFLICT target updated to new index
--   - trading/phase6OrderService.ts     : threads matchId (plus fixes maker-scope bug)
--   - triggers/triggerEngine.ts         : threads matchId for derived orders
--   - bot/botRunner.ts                  : explicit matchId: null (free play)
--   - jobs/definitions/marketMakerJob.ts: explicit matchId: null (free play)
--   - competitions/matchService.ts      : closeMatchScopedPositions in completeMatch/forfeitMatch
--   - routes/analyticsRoutes.ts         : GET /positions filters by active match
--
-- Reversibility:
--   Forward-only. To revert manually, drop the four match_id columns and
--   rebuild the old 3-col unique indexes from migration 042 — but do this
--   only before any production row has non-NULL match_id, or you will
--   lose match-scoped history.
-- ============================================================


-- ────────────────────────────────────────────────────────────
-- A. POSITIONS
-- ────────────────────────────────────────────────────────────

ALTER TABLE positions ADD COLUMN IF NOT EXISTS match_id UUID DEFAULT NULL;

-- FK: ADD CONSTRAINT has no IF NOT EXISTS before Postgres 16.5+, so guard
-- via pg_constraint lookup. Idempotent across re-runs.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'positions_match_fk'
          AND conrelid = 'positions'::regclass
    ) THEN
        ALTER TABLE positions
            ADD CONSTRAINT positions_match_fk
            FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE SET NULL;
    END IF;
END $$;

-- Replace the (user_id, pair_id, competition_id) unique index with the
-- 4-col version that also includes match_id. COALESCE collapses NULLs to
-- the nil UUID so "free play" (both NULL) remains a single row per pair.
DROP INDEX IF EXISTS positions_user_pair_comp_unique;

CREATE UNIQUE INDEX IF NOT EXISTS positions_user_pair_scope_unique
    ON positions (
        user_id,
        pair_id,
        COALESCE(competition_id, '00000000-0000-0000-0000-000000000000'::uuid),
        COALESCE(match_id,       '00000000-0000-0000-0000-000000000000'::uuid)
    );

-- Hot path: "give me this user's open match-scoped positions" for the
-- match UI. Partial index keeps it small — only non-flat rows in a match.
CREATE INDEX IF NOT EXISTS idx_positions_user_match_open
    ON positions (user_id, match_id)
    WHERE base_qty <> 0 AND match_id IS NOT NULL;


-- ────────────────────────────────────────────────────────────
-- B. WALLETS
-- ────────────────────────────────────────────────────────────

ALTER TABLE wallets ADD COLUMN IF NOT EXISTS match_id UUID DEFAULT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'wallets_match_fk'
          AND conrelid = 'wallets'::regclass
    ) THEN
        ALTER TABLE wallets
            ADD CONSTRAINT wallets_match_fk
            FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE SET NULL;
    END IF;
END $$;

DROP INDEX IF EXISTS wallets_user_asset_comp_unique;

CREATE UNIQUE INDEX IF NOT EXISTS wallets_user_asset_scope_unique
    ON wallets (
        user_id,
        asset_id,
        COALESCE(competition_id, '00000000-0000-0000-0000-000000000000'::uuid),
        COALESCE(match_id,       '00000000-0000-0000-0000-000000000000'::uuid)
    );


-- ────────────────────────────────────────────────────────────
-- C. EQUITY_SNAPSHOTS
-- ────────────────────────────────────────────────────────────

ALTER TABLE equity_snapshots ADD COLUMN IF NOT EXISTS match_id UUID DEFAULT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'equity_snapshots_match_fk'
          AND conrelid = 'equity_snapshots'::regclass
    ) THEN
        ALTER TABLE equity_snapshots
            ADD CONSTRAINT equity_snapshots_match_fk
            FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE SET NULL;
    END IF;
END $$;

DROP INDEX IF EXISTS equity_snapshots_user_ts_comp_unique;

CREATE UNIQUE INDEX IF NOT EXISTS equity_snapshots_user_ts_scope_unique
    ON equity_snapshots (
        user_id,
        ts,
        COALESCE(competition_id, '00000000-0000-0000-0000-000000000000'::uuid),
        COALESCE(match_id,       '00000000-0000-0000-0000-000000000000'::uuid)
    );


-- ────────────────────────────────────────────────────────────
-- D. ORDERS
-- ────────────────────────────────────────────────────────────
-- Orders don't have a scope-based unique index today (only PK on id), so
-- we just add the column + FK + a small filter index for analytics joins.

ALTER TABLE orders ADD COLUMN IF NOT EXISTS match_id UUID DEFAULT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'orders_match_fk'
          AND conrelid = 'orders'::regclass
    ) THEN
        ALTER TABLE orders
            ADD CONSTRAINT orders_match_fk
            FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE SET NULL;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_orders_match
    ON orders (match_id)
    WHERE match_id IS NOT NULL;
