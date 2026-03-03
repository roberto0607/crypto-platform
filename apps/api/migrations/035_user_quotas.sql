-- Phase 10 PR6: Per-user trading quotas
CREATE TABLE user_quotas (
    user_id            UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    max_orders_per_min INT NOT NULL DEFAULT 60,
    max_open_orders    INT NOT NULL DEFAULT 100,
    max_daily_orders   INT NOT NULL DEFAULT 5000,
    trading_enabled    BOOLEAN NOT NULL DEFAULT true,
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER user_quotas_set_updated_at
    BEFORE UPDATE ON user_quotas FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();
