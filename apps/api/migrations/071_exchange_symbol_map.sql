-- Gate 2 (multi-asset expansion): per-exchange symbol mapping + trigram symbol search.
--
-- exchange_symbol_map replaces the hardcoded SYMBOL_MAP/PRODUCT_MAP/CB_PAIR_MAP
-- literals in krakenWs.ts/coinbaseWs.ts/candleBackfill.ts with data, so the feed
-- layer can subscribe to whatever pairs are active without a redeploy. ws_symbol
-- and rest_symbol are tracked separately because Kraken's WS v2 and REST APIs use
-- different symbol formats for the same pair (e.g. WS v2 "BTC/USD" vs REST
-- "XBTUSD"), and WS v2's accepted symbol cannot always be derived from the REST
-- AssetPairs "wsname" field (verified live: wsname reports "XBT/USD" for BTC, but
-- Kraken's WS v2 rejects that and only accepts "BTC/USD").
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE exchange_symbol_map (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pair_id UUID NOT NULL REFERENCES trading_pairs(id) ON DELETE CASCADE,
    exchange TEXT NOT NULL CHECK (exchange IN ('kraken', 'coinbase')),
    ws_symbol TEXT NOT NULL,
    rest_symbol TEXT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT exchange_symbol_map_unique UNIQUE (pair_id, exchange)
);

CREATE INDEX idx_exchange_symbol_map_active ON exchange_symbol_map (exchange) WHERE is_active = true;

CREATE TRIGGER exchange_symbol_map_set_updated_at
    BEFORE UPDATE ON exchange_symbol_map FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

-- Symbol search (searchSymbols datafeed method) — trigram similarity over
-- trading_pairs.symbol. Table is tiny today (4 rows) so a plain (non-CONCURRENT)
-- index build inside this migration's transaction is safe.
CREATE INDEX idx_trading_pairs_symbol_trgm ON trading_pairs USING GIN (symbol gin_trgm_ops);
