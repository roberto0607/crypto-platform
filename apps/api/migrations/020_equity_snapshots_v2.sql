-- Phase 8 PR3: Enrich equity_snapshots with portfolio breakdown columns
ALTER TABLE equity_snapshots
    ADD COLUMN cash_quote           NUMERIC(28, 8),
    ADD COLUMN holdings_quote       NUMERIC(28, 8),
    ADD COLUMN unrealized_pnl_quote NUMERIC(28, 8),
    ADD COLUMN realized_pnl_quote   NUMERIC(28, 8),
    ADD COLUMN fees_paid_quote      NUMERIC(28, 8);
