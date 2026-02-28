-- Phase 9 PR1: Account-level governance limits
CREATE TABLE account_limits (
    user_id              UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    max_daily_notional_quote   NUMERIC(28, 8) NULL,
    max_daily_realized_loss_quote NUMERIC(28, 8) NULL,
    max_open_positions   INT NULL,
    max_open_orders      INT NULL,
    account_status       TEXT NOT NULL DEFAULT 'ACTIVE',
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT account_limits_status_check
        CHECK (account_status IN ('ACTIVE', 'SUSPENDED', 'LOCKED'))
);

CREATE INDEX idx_account_limits_status ON account_limits(account_status);

CREATE TRIGGER account_limits_set_updated_at
    BEFORE UPDATE ON account_limits FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();
