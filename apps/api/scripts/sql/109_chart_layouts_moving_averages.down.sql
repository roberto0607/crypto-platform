-- Down for migration 109 (chart layouts: EMA toggles → moving-average list).
--
-- Puts back the original config (and updated_at) of every layout 109
-- rewrote, from chart_layouts_pre_109, then un-registers 109 so a later
-- `pnpm migrate` would convert them again. Layouts 109 didn't touch, and
-- layouts created after it, are left alone.
--
-- A layout the user saved again after 109 is NOT restored (its updated_at
-- moved: 109 keeps updated_at, any save bumps it), so no later edit is lost.
-- Drop the `AND c.updated_at = b.updated_at` line to restore those too.
--
-- Rolling back the web/API code is separate: the pre-list build reads only the
-- ema20/50/200 toggles, which this restores.
--
-- Run: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f scripts/sql/109_chart_layouts_moving_averages.down.sql

ALTER TABLE chart_layouts DISABLE TRIGGER chart_layouts_set_updated_at;

UPDATE chart_layouts c
SET config = b.config, updated_at = b.updated_at
FROM chart_layouts_pre_109 b
WHERE c.id = b.layout_id
  AND c.updated_at = b.updated_at;

ALTER TABLE chart_layouts ENABLE TRIGGER chart_layouts_set_updated_at;

DELETE FROM schema_migrations WHERE id = '109_chart_layouts_moving_averages.sql';
