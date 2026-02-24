-- Phase 4: Orders and trades (executions)
CREATE TABLE orders(
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id),
    pair_id UUID NOT NULL REFERENCES trading_pairs(id),
    side TEXT NOT NULL,
    type TEXT NOT NULL,
    limit_price NUMERIC(28, 8) NULL,
    qty NUMERIC(28, 8) NOT NULL,
    qty_filled NUMERIC(28, 8) NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'OPEN',
    reserved_wallet_id UUID REFERENCES wallets(id),
    reserved_amount NUMERIC(28, 8) NOT NULL DEFAULT 0,
    reserved_consumed NUMERIC(28, 8) NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT orders_side_check CHECK (side IN ('BUY', 'SELL')),
    CONSTRAINT orders_type_check CHECK (type IN ('MARKET', 'LIMIT')),
    CONSTRAINT orders_status_check CHECK (
        status IN ('OPEN', 'PARTIALLY_FILLED', 'FILLED', 'CANCELED', 'REJECTED')
    ),
    CONSTRAINT orders_qty_positive CHECK (qty > 0),
    CONSTRAINT orders_qty_filled_valid CHECK (qty_filled >= 0 AND qty_filled <= qty),
    CONSTRAINT orders_limit_price_rule CHECK (
        (type = 'LIMIT' AND limit_price IS NOT NULL AND limit_price > 0)
        OR (type = 'MARKET' AND limit_price IS NULL)
    ),
    CONSTRAINT orders_reserved_valid CHECK (
        reserved_consumed >= 0 AND reserved_consumed <= reserved_amount
    )
);

CREATE INDEX idx_orders_user_id ON orders (user_id);
CREATE INDEX idx_orders_pair_status ON orders (pair_id, status);
CREATE INDEX idx_orders_book ON orders (pair_id, side, limit_price, created_at)
    WHERE status IN ('OPEN', 'PARTIALLY_FILLED') AND type = 'LIMIT';

CREATE TABLE trades (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pair_id UUID NOT NULL REFERENCES trading_pairs(id),
    buy_order_id UUID REFERENCES orders(id),
    sell_order_id UUID REFERENCES orders(id),
    price NUMERIC(28, 8) NOT NULL,
    qty NUMERIC(28, 8) NOT NULL,
    quote_amount NUMERIC(28, 8) NOT NULL,
    fee_amount NUMERIC(28, 8) NOT NULL DEFAULT 0,
    fee_asset_id UUID REFERENCES assets(id),
    is_system_fill BOOLEAN NOT NULL DEFAULT false,
    executed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT trades_price_positive CHECK (price > 0),
    CONSTRAINT trades_qty_positive CHECK (qty > 0),
    CONSTRAINT trades_has_order CHECK (
        buy_order_id IS NOT NULL OR sell_order_id IS NOT NULL
    )
);

CREATE INDEX idx_trades_pair ON trades (pair_id);
CREATE INDEX idx_trades_buy_order ON trades (buy_order_id) WHERE buy_order_id IS NOT NULL;
CREATE INDEX idx_trades_sell_order ON trades (sell_order_id) WHERE sell_order_id IS NOT NULL;

CREATE TRIGGER orders_set_updated_at
    BEFORE UPDATE ON orders FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();
    
    