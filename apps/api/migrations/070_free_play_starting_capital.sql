-- Migration 070: Free-play starting capital (FREE_PLAY_CREDIT ledger type)
--
-- New users land on the free-play trade page with $0 and cannot trade, even
-- though the landing page promises "$100K virtual capital loaded automatically."
-- The $100K was only ever credited on competition/season join (COMPETITION_CREDIT).
-- We now fund the free-play (competition_id IS NULL) USD wallet with the same
-- starting capital at signup, booked through the ledger as a distinct
-- FREE_PLAY_CREDIT entry so free-play grants stay auditable and separable from
-- ranked COMPETITION_CREDIT funding.
--
-- Part A: allow the new entry type on ledger_entries.
ALTER TABLE ledger_entries DROP CONSTRAINT IF EXISTS ledger_entry_type_check;
ALTER TABLE ledger_entries ADD CONSTRAINT ledger_entry_type_check CHECK (
    entry_type IN (
        'DEPOSIT', 'WITHDRAWAL', 'TRADE_BUY', 'TRADE_SELL', 'FEE',
        'ADMIN_CREDIT', 'ADMIN_DEBIT',
        'COMPETITION_CREDIT', 'COMPETITION_RESET',
        'FREE_PLAY_CREDIT'
    )
);

-- Part B: hard idempotency backstop — a wallet can receive the free-play grant
-- at most once. The application also guards with a check-then-insert, but this
-- partial unique index makes a double-credit ($200K) structurally impossible
-- even under a concurrent retry.
CREATE UNIQUE INDEX IF NOT EXISTS ledger_free_play_credit_once
    ON ledger_entries (wallet_id)
    WHERE entry_type = 'FREE_PLAY_CREDIT';
