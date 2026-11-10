-- Why a 1v1 ELO change was unrated or scaled, in enough detail for the UI to
-- say it in plain words (ELO_INTEGRITY_ENABLED). Additive: written only with
-- the flag on; NULL on every row resolved before it or with the flag off.
--
-- pair_match_number: this match's number for the pair in the 24h window
--                    (1st full value, 2nd 50%, 3rd+ 0% / REPEAT_OPPONENT).
-- winner_qualified / loser_qualified: whether each player made a fill of
--                    their own and traded 10% of starting capital
--                    (NOT_QUALIFIED names which one didn't).
ALTER TABLE match_elo_results
    ADD COLUMN pair_match_number INTEGER CHECK (pair_match_number >= 1),
    ADD COLUMN winner_qualified BOOLEAN,
    ADD COLUMN loser_qualified BOOLEAN;
