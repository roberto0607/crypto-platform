-- Migration 069: Fix user_tiers_tier_check to allow BOTH tier vocabularies
--
-- Bug: forfeiting/completing a 1v1 match 500'd (Postgres 23514) whenever the
-- winner crossed a tier-promotion boundary. resolveMatchElo → updateUserTierTx
-- wrote tier='PRO' (or 'ELITE') into user_tiers, but user_tiers_tier_check —
-- created by migration 047 with the weekly-competition 6-tier vocabulary —
-- only allowed ROOKIE/TRADER/SPECIALIST/EXPERT/MASTER/LEGEND. The whole forfeit
-- transaction rolled back, so the match stayed ACTIVE and the match-end push
-- never fired (it runs post-COMMIT). Prod stack trace: eloService updateUserTierTx
-- → resolveMatchElo → forfeitMatch.
--
-- WHY THE UNION (do NOT "tidy" this back to one system's 4 tiers):
-- user_tiers is a SHARED table written by TWO different tier systems:
--   • Trade Wars 1v1 ELO  (eloService.ts, TW_TIERS)            → ROOKIE, PRO, ELITE, LEGEND
--   • Weekly competitions (tierRepo/weeklyCompetitionJob, TIERS) → ROOKIE, TRADER, SPECIALIST,
--                                                                  EXPERT, MASTER, LEGEND
-- Both upsert user_tiers.tier. The constraint must therefore be the UNION of both
-- vocabularies. Narrowing it to either system's set alone WILL 500 the other system's
-- tier write (e.g. 4-tier-only re-breaks weekly's TRADER/SPECIALIST/EXPERT/MASTER writes;
-- 6-tier-only is the bug we're fixing here). The two systems sharing one column with
-- incompatible vocabularies is a deeper latent conflict tracked in docs/followups.md.
--
-- competitions_tier_check is deliberately left UNTOUCHED: it is NOT a stale twin —
-- it backs 60 legitimate 6-tier weekly-competition rows and matches that system.
--
-- Safe re-ADD: pre-flight confirmed 0 existing user_tiers rows violate the union
-- (prod holds only ROOKIE), so no data-migration step is needed.

ALTER TABLE user_tiers DROP CONSTRAINT IF EXISTS user_tiers_tier_check;

ALTER TABLE user_tiers ADD CONSTRAINT user_tiers_tier_check
    CHECK (tier IN ('ROOKIE', 'PRO', 'ELITE', 'LEGEND', 'TRADER', 'SPECIALIST', 'EXPERT', 'MASTER'));
