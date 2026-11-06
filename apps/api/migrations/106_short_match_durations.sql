-- 15-minute, 1-hour and 4-hour matches. duration_hours goes from INTEGER to
-- double precision so 0.25 fits: pg returns it as a JS number, like before, and
-- code from before this migration keeps working while a deploy rolls out.
ALTER TABLE matches DROP CONSTRAINT matches_duration_hours_check;
ALTER TABLE matches ALTER COLUMN duration_hours TYPE double precision;
ALTER TABLE matches ADD CONSTRAINT matches_duration_hours_check
    CHECK (duration_hours IN (0.25, 1, 4, 24, 168, 336, 504, 672));
