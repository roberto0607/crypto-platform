-- ELO integrity (ELO_INTEGRITY_ENABLED). Additive: nothing writes these with
-- the flag off, and no past match, ELO or season score is recomputed.
--
-- match_ratings: one row per player per match resolved with the flag on —
-- whether that player's side was rated, and the season points it earned. The
-- season board is built from these rows only.
CREATE TABLE match_ratings (
    match_id       UUID        NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
    user_id        UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    opponent_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    result         TEXT        NOT NULL CHECK (result IN ('WIN', 'LOSS', 'DRAW')),
    rated          BOOLEAN     NOT NULL,
    unrated_reason TEXT        CHECK (unrated_reason IN ('EARLY_FORFEIT', 'NOT_QUALIFIED', 'REPEAT_OPPONENT')),
    pair_scale     NUMERIC(3,2) NOT NULL,
    elo_delta      INTEGER     NOT NULL,
    season_id      UUID        REFERENCES competitions(id) ON DELETE CASCADE,
    season_streak  INTEGER,
    season_weight  NUMERIC(3,2),
    season_points  NUMERIC(12,2),
    completed_at   TIMESTAMPTZ NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (match_id, user_id),
    CHECK (rated = (unrated_reason IS NULL))
);

CREATE INDEX idx_match_ratings_season_user ON match_ratings (season_id, user_id, completed_at);

-- Why a winner got no ELO (NULL = rated). Shown as UNRATED in the UI.
ALTER TABLE match_elo_results
    ADD COLUMN winner_unrated_reason TEXT
    CHECK (winner_unrated_reason IN ('EARLY_FORFEIT', 'NOT_QUALIFIED', 'REPEAT_OPPONENT'));
