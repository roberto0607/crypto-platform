-- Migration 093: FEE_CORRECTION ledger type (one-time fee overcharge refund)
--
-- Until PR #201 the matching engine charged the deprecated trading_pairs.fee_bps
-- (30) on taker fills instead of taker_fee_bps (5). The refund script
-- (pnpm fees:refund-overcharge, src/trading/feeRefund.ts) credits each affected
-- free-play wallet once, booked as a distinct FEE_CORRECTION entry so the refund
-- stays auditable and separable from trading and funding entries.
--
-- Part A: allow the new entry type on ledger_entries.
ALTER TABLE ledger_entries DROP CONSTRAINT IF EXISTS ledger_entry_type_check;
ALTER TABLE ledger_entries ADD CONSTRAINT ledger_entry_type_check CHECK (
    entry_type IN (
        'DEPOSIT', 'WITHDRAWAL', 'TRADE_BUY', 'TRADE_SELL', 'FEE',
        'ADMIN_CREDIT', 'ADMIN_DEBIT',
        'COMPETITION_CREDIT', 'COMPETITION_RESET',
        'FREE_PLAY_CREDIT',
        'FEE_CORRECTION'
    )
);

-- Part B: hard idempotency backstop, same as FREE_PLAY_CREDIT (070). The script
-- skips wallets that already have a FEE_CORRECTION entry; this index makes a
-- double refund structurally impossible even if two runs overlap.
CREATE UNIQUE INDEX IF NOT EXISTS ledger_fee_correction_once
    ON ledger_entries (wallet_id)
    WHERE entry_type = 'FEE_CORRECTION';
