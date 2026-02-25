-- Phase 5 PR1: Maker/taker fee model on trading_pairs
-- fee_bps is kept for backward compatibility (used by matching engine today).
-- DEPRECATED: fee_bps will be removed once the matching engine switches to maker_fee_bps / taker_fee_bps.

ALTER TABLE trading_pairs
    ADD COLUMN maker_fee_bps INT NOT NULL DEFAULT 2
        CONSTRAINT pairs_maker_fee_range CHECK (maker_fee_bps >= 0 AND maker_fee_bps <= 10000),
    ADD COLUMN taker_fee_bps INT NOT NULL DEFAULT 5
        CONSTRAINT pairs_taker_fee_range CHECK (taker_fee_bps >= 0 AND taker_fee_bps <= 10000);