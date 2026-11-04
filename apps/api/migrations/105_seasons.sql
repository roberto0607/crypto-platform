-- Seasons. Migration 057 assumed competition_type had no CHECK, but 047 added
-- one, so a SEASON row could never be inserted.
ALTER TABLE competitions DROP CONSTRAINT IF EXISTS competitions_competition_type_check;
ALTER TABLE competitions ADD CONSTRAINT competitions_competition_type_check
    CHECK (competition_type IN ('CUSTOM', 'WEEKLY', 'SEASON'));

-- There is one global season (tier NULL) at a time. idx_competitions_season_tier
-- can't enforce numbering for it: NULL tiers never conflict.
CREATE UNIQUE INDEX competitions_one_open_season
    ON competitions ((true))
    WHERE competition_type = 'SEASON' AND status IN ('UPCOMING', 'ACTIVE');

CREATE UNIQUE INDEX competitions_season_number_uq
    ON competitions (season_number)
    WHERE competition_type = 'SEASON';
