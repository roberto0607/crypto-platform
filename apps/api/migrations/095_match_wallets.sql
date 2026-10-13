-- Migration 095: real per-match wallets
--
-- Until now wallets.match_id (066) was never set: match orders debited and
-- credited the players' FREE-PLAY wallets, and the match-end force-close only
-- rewrote positions, so a match's cash and base never left free-play. A match
-- short counted against free-play buying power, starting_capital wasn't
-- enforced, and an ended match left its footprint in free-play for good.
--
-- From this migration a match has its own wallets per player
-- (match_id = the match): funded with starting_capital when the match is
-- accepted (MATCH_FUNDING), traded by every match-scoped order, settled to
-- USD at match end (MATCH_SETTLEMENT), then closed (closed_at). Nothing moves
-- between a match's wallets and free-play.

-- Part A: closed wallets keep their final balances but take no more orders.
ALTER TABLE wallets ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ DEFAULT NULL;

-- Part B: match_id FK SET NULL → NO ACTION. SET NULL would turn a deleted
-- match's wallets into a second set of "free-play" wallets — it collides with
-- wallets_user_asset_scope_unique and fails anyway. A match with wallets can't
-- be deleted (the code never deletes matches).
ALTER TABLE wallets DROP CONSTRAINT IF EXISTS wallets_match_fk;
ALTER TABLE wallets
    ADD CONSTRAINT wallets_match_fk
    FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE NO ACTION;

CREATE INDEX IF NOT EXISTS idx_wallets_match
    ON wallets (match_id)
    WHERE match_id IS NOT NULL;

-- Part C: the two match ledger entry types.
ALTER TABLE ledger_entries DROP CONSTRAINT IF EXISTS ledger_entry_type_check;
ALTER TABLE ledger_entries ADD CONSTRAINT ledger_entry_type_check CHECK (
    entry_type IN (
        'DEPOSIT', 'WITHDRAWAL', 'TRADE_BUY', 'TRADE_SELL', 'FEE',
        'ADMIN_CREDIT', 'ADMIN_DEBIT',
        'COMPETITION_CREDIT', 'COMPETITION_RESET',
        'FREE_PLAY_CREDIT',
        'FEE_CORRECTION',
        'MATCH_FUNDING', 'MATCH_SETTLEMENT'
    )
);

-- A match wallet is funded once.
CREATE UNIQUE INDEX IF NOT EXISTS ledger_match_funding_once
    ON ledger_entries (wallet_id)
    WHERE entry_type = 'MATCH_FUNDING';
