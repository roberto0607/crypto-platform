-- Migration 109: chart layouts — EMA 20/50/200 toggles → moving-average list
--
-- The chart's fixed EMA 20/50/200 toggles became a list of moving averages
-- (params.movingAverages: { id, type, length, color }), with golden/death-cross
-- markers on any two of them (params.maCross: { fast, slow }). Every saved
-- layout that names the old toggles is rewritten so it draws the same lines:
--
--   - each of ema20/ema50/ema200 that was ON becomes an EMA line with that
--     length and its old color (id = the old key), in that order;
--   - with ema50 AND ema200 on, the cross markers stay on those two (the old
--     chart drew them exactly then);
--   - the old keys are removed from `indicators` (on or off);
--   - a layout that already has params.movingAverages keeps its lines.
--
-- Mirrors upgradeLegacyEmaConfig in src/chartLayouts/catalog.ts; the test
-- chartLayoutsMigration109.test.ts runs this file and compares the two.
-- Safety:
--   - Only rows whose `indicators` names ema20/ema50/ema200 are touched; every
--     other layout is left byte-for-byte as it was (config and updated_at).
--   - Idempotent: a second run finds no old keys and changes nothing.
--   - updated_at is kept — the user didn't edit these layouts.
--   - Reversible: each rewritten row's ORIGINAL config is saved first in
--     chart_layouts_pre_109 (kept on re-runs: ON CONFLICT DO NOTHING).
--     scripts/sql/109_chart_layouts_moving_averages.down.sql puts them back.
--     Once the moving-average list has been live a while, drop the table.

CREATE TABLE IF NOT EXISTS chart_layouts_pre_109 (
  layout_id  UUID PRIMARY KEY REFERENCES chart_layouts(id) ON DELETE CASCADE,
  config     JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  saved_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO chart_layouts_pre_109 (layout_id, config, updated_at)
SELECT id, config, updated_at
FROM chart_layouts
WHERE jsonb_typeof(config->'indicators') = 'object'
  AND config->'indicators' ?| ARRAY['ema20', 'ema50', 'ema200']
ON CONFLICT (layout_id) DO NOTHING;

ALTER TABLE chart_layouts DISABLE TRIGGER chart_layouts_set_updated_at;

WITH legacy AS (
  SELECT
    id,
    config,
    COALESCE(config->'params', '{}'::jsonb) AS params,
    (config->'indicators'->'ema20')  = 'true'::jsonb AS e20,
    (config->'indicators'->'ema50')  = 'true'::jsonb AS e50,
    (config->'indicators'->'ema200') = 'true'::jsonb AS e200
  FROM chart_layouts
  WHERE jsonb_typeof(config->'indicators') = 'object'
    AND config->'indicators' ?| ARRAY['ema20', 'ema50', 'ema200']
),
built AS (
  SELECT
    l.*,
    (
      SELECT COALESCE(jsonb_agg(v.line ORDER BY v.ord), '[]'::jsonb)
      FROM (VALUES
        (1, l.e20,  jsonb_build_object('id', 'ema20',  'type', 'EMA', 'length', 20,  'color', '#3b82f6')),
        (2, l.e50,  jsonb_build_object('id', 'ema50',  'type', 'EMA', 'length', 50,  'color', '#f59e0b')),
        (3, l.e200, jsonb_build_object('id', 'ema200', 'type', 'EMA', 'length', 200, 'color', '#ef4444'))
      ) AS v(ord, is_on, line)
      WHERE v.is_on IS TRUE
    ) AS lines
  FROM legacy l
)
UPDATE chart_layouts c
SET config =
  jsonb_set(c.config, '{indicators}', (c.config->'indicators') - 'ema20' - 'ema50' - 'ema200')
  || CASE
       WHEN jsonb_array_length(b.lines) > 0 AND NOT (b.params ? 'movingAverages') THEN
         jsonb_build_object(
           'params',
           b.params
             || jsonb_build_object('movingAverages', b.lines)
             || CASE
                  WHEN b.e50 IS TRUE AND b.e200 IS TRUE AND NOT (b.params ? 'maCross')
                    THEN jsonb_build_object('maCross', jsonb_build_object('fast', 'ema50', 'slow', 'ema200'))
                  ELSE '{}'::jsonb
                END
         )
       ELSE '{}'::jsonb
     END
FROM built b
WHERE c.id = b.id;

ALTER TABLE chart_layouts ENABLE TRIGGER chart_layouts_set_updated_at;
