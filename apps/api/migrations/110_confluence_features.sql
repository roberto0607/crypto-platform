-- ============================================================
-- 110_confluence_features.sql
-- Feature recorder for the confluence setup scanner (Phase 1).
-- ============================================================
--
-- Three tables, all research/agent data. Nothing in trading reads them.
--
--   feature_candles   Coinbase BTC-USD 1h + 1d candles. Live prod BTC
--                     candles are built from Kraken (market/candleSource.ts)
--                     while the feature history is Coinbase, so the recorder
--                     keeps its own single-source copy: backfilled and live
--                     rows see the same exchange.
--   external_series   Raw points from external sources (funding, open
--                     interest, Fear & Greed), so features can be recomputed
--                     without re-downloading. Prod stores 1h resolution only
--                     (last value per hour); full resolution lives only in
--                     local research DBs.
--   setup_features    One row per closed 4h bar per symbol per feature
--                     version: the features as known at that bar's close.
--                     NULL = not computable (warm-up, source missing, or a
--                     live-only feature on a backfilled row); `missing`
--                     says which and why.
--
-- Size: ~2,200 setup_features rows a year; writes are non-essential and
-- pause under the DB-size guardrail (observability/writePause.ts).
-- Additive only.
-- ============================================================

CREATE TABLE IF NOT EXISTS feature_candles (
    symbol     TEXT NOT NULL,
    timeframe  TEXT NOT NULL CHECK (timeframe IN ('1h', '1d')),
    ts         TIMESTAMPTZ NOT NULL,
    open       DOUBLE PRECISION NOT NULL,
    high       DOUBLE PRECISION NOT NULL,
    low        DOUBLE PRECISION NOT NULL,
    close      DOUBLE PRECISION NOT NULL,
    volume     DOUBLE PRECISION NOT NULL,
    source     TEXT NOT NULL DEFAULT 'coinbase' CHECK (source IN ('coinbase')),
    PRIMARY KEY (symbol, timeframe, ts)
);

CREATE TABLE IF NOT EXISTS external_series (
    series  TEXT NOT NULL,
    ts      TIMESTAMPTZ NOT NULL,
    value   DOUBLE PRECISION NOT NULL,
    meta    JSONB,
    PRIMARY KEY (series, ts)
);

CREATE TABLE IF NOT EXISTS setup_features (
    symbol           TEXT NOT NULL,
    bar_time         TIMESTAMPTZ NOT NULL,          -- the 4h bar's open; features are as of bar_time + 4h
    feature_version  INTEGER NOT NULL,
    origin           TEXT NOT NULL CHECK (origin IN ('backfill', 'live')),
    recorded_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    recorded_late    BOOLEAN NOT NULL DEFAULT false,
    close            DOUBLE PRECISION NOT NULL,
    atr14_4h         DOUBLE PRECISION,

    -- Trend
    t_w_sma20_dist   DOUBLE PRECISION,
    t_w_sma50_dist   DOUBLE PRECISION,
    t_w_sma200_dist  DOUBLE PRECISION,
    t_d_sma50_dist   DOUBLE PRECISION,
    t_d_sma200_dist  DOUBLE PRECISION,
    t_w_sma20_slope  DOUBLE PRECISION,
    t_w_sma50_slope  DOUBLE PRECISION,
    t_w_sma200_slope DOUBLE PRECISION,
    t_d_sma50_slope  DOUBLE PRECISION,
    t_d_sma200_slope DOUBLE PRECISION,
    -- Momentum
    m_rsi14_4h       DOUBLE PRECISION,
    m_rsi14_1d       DOUBLE PRECISION,
    m_macd_hist_atr_4h DOUBLE PRECISION,
    m_macd_hist_atr_1d DOUBLE PRECISION,
    -- Location
    l_sup_1d_atr     DOUBLE PRECISION,
    l_res_1d_atr     DOUBLE PRECISION,
    l_sup_1w_atr     DOUBLE PRECISION,
    l_res_1w_atr     DOUBLE PRECISION,
    l_room_long_r    DOUBLE PRECISION,
    l_room_short_r   DOUBLE PRECISION,
    l_pdh_atr        DOUBLE PRECISION,
    l_pdl_atr        DOUBLE PRECISION,
    l_pwh_atr        DOUBLE PRECISION,
    l_pwl_atr        DOUBLE PRECISION,
    -- Volatility / regime
    v_atr_pct_4h     DOUBLE PRECISION,
    v_atr_pct_1d     DOUBLE PRECISION,
    v_atr_pct_rank_1y DOUBLE PRECISION,
    v_adx_4h         DOUBLE PRECISION,
    v_adx_1d         DOUBLE PRECISION,
    v_di_diff_4h     DOUBLE PRECISION,
    v_di_diff_1d     DOUBLE PRECISION,
    -- Positioning (filled from PR 1b)
    p_funding_8h     DOUBLE PRECISION,
    p_funding_avg_7d DOUBLE PRECISION,
    p_funding_rank_1y DOUBLE PRECISION,
    p_oi_usd         DOUBLE PRECISION,
    p_oi_chg_24h     DOUBLE PRECISION,
    p_oi_chg_7d      DOUBLE PRECISION,
    -- Order flow (real CVD + book imbalance: live only, PR 1b)
    f_cvd_proxy_24h  DOUBLE PRECISION,
    f_cvd_proxy_7d   DOUBLE PRECISION,
    f_cvd_real_24h   DOUBLE PRECISION,
    f_cvd_real_7d    DOUBLE PRECISION,
    f_book_imbalance DOUBLE PRECISION,
    -- Events (news gate: live only, PR 1b)
    e_hours_to_fomc    DOUBLE PRECISION,
    e_hours_since_fomc DOUBLE PRECISION,
    e_fomc_within_7d   BOOLEAN,
    e_hours_to_cpi     DOUBLE PRECISION,
    e_hours_since_cpi  DOUBLE PRECISION,
    e_cpi_within_7d    BOOLEAN,
    e_news_gate        BOOLEAN,
    -- Sentiment (filled from PR 1b)
    s_fng            DOUBLE PRECISION,
    s_fng_chg_7d     DOUBLE PRECISION,

    missing          JSONB NOT NULL DEFAULT '{}'::jsonb,  -- { column: reason }
    PRIMARY KEY (symbol, bar_time, feature_version)
);
