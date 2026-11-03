-- Migration 101: chart_layouts
--
-- Saved chart layouts per user (which indicators/panes are on, pane order,
-- collapsed state and heights, VPVR mode, timeframe), so a layout follows
-- the user across devices. Drawings are NOT stored here.
--
-- config is validated by the API (src/chartLayouts/configSchema.ts) against
-- catalog.json; the DB only caps its size as a backstop.
CREATE TABLE IF NOT EXISTS chart_layouts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 40),
  config      JSONB NOT NULL CHECK (pg_column_size(config) <= 32768),
  is_default  BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chart_layouts_user_name_key UNIQUE (user_id, name)
);

-- At most one default layout per user.
CREATE UNIQUE INDEX IF NOT EXISTS chart_layouts_one_default_per_user
  ON chart_layouts (user_id) WHERE is_default;

DROP TRIGGER IF EXISTS chart_layouts_set_updated_at ON chart_layouts;
CREATE TRIGGER chart_layouts_set_updated_at
  BEFORE UPDATE ON chart_layouts
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();
