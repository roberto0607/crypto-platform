/**
 * Every feature column in setup_features, with where its value comes from.
 * `candles` and `events` are computed here (PR 1a). `external` (funding,
 * OI, Fear & Greed) and `live` (real CVD, book imbalance, news gate) are
 * written from PR 1b. Until a source is wired, the column is NULL and
 * `missing` says why.
 */
export type FeatureSource = "candles" | "events" | "external" | "live";
export type FeatureGroup = "trend" | "momentum" | "location" | "volatility" | "positioning" | "flow" | "events" | "sentiment";

export interface FeatureColumn {
  name: string;
  kind: "num" | "bool";
  group: FeatureGroup;
  source: FeatureSource;
}

const col = <N extends string, K extends "num" | "bool" = "num">(name: N, group: FeatureGroup, source: FeatureSource, kind?: K) =>
  ({ name, kind: (kind ?? "num") as K, group, source }) satisfies FeatureColumn;

export const FEATURE_COLUMNS = [
  col("t_w_sma20_dist", "trend", "candles"),
  col("t_w_sma50_dist", "trend", "candles"),
  col("t_w_sma200_dist", "trend", "candles"),
  col("t_d_sma50_dist", "trend", "candles"),
  col("t_d_sma200_dist", "trend", "candles"),
  col("t_w_sma20_slope", "trend", "candles"),
  col("t_w_sma50_slope", "trend", "candles"),
  col("t_w_sma200_slope", "trend", "candles"),
  col("t_d_sma50_slope", "trend", "candles"),
  col("t_d_sma200_slope", "trend", "candles"),
  col("m_rsi14_4h", "momentum", "candles"),
  col("m_rsi14_1d", "momentum", "candles"),
  col("m_macd_hist_atr_4h", "momentum", "candles"),
  col("m_macd_hist_atr_1d", "momentum", "candles"),
  col("l_sup_1d_atr", "location", "candles"),
  col("l_res_1d_atr", "location", "candles"),
  col("l_sup_1w_atr", "location", "candles"),
  col("l_res_1w_atr", "location", "candles"),
  col("l_room_long_r", "location", "candles"),
  col("l_room_short_r", "location", "candles"),
  col("l_pdh_atr", "location", "candles"),
  col("l_pdl_atr", "location", "candles"),
  col("l_pwh_atr", "location", "candles"),
  col("l_pwl_atr", "location", "candles"),
  col("v_atr_pct_4h", "volatility", "candles"),
  col("v_atr_pct_1d", "volatility", "candles"),
  col("v_atr_pct_rank_1y", "volatility", "candles"),
  col("v_adx_4h", "volatility", "candles"),
  col("v_adx_1d", "volatility", "candles"),
  col("v_di_diff_4h", "volatility", "candles"),
  col("v_di_diff_1d", "volatility", "candles"),
  col("p_funding_8h", "positioning", "external"),
  col("p_funding_avg_7d", "positioning", "external"),
  col("p_funding_rank_1y", "positioning", "external"),
  col("p_oi_usd", "positioning", "external"),
  col("p_oi_chg_24h", "positioning", "external"),
  col("p_oi_chg_7d", "positioning", "external"),
  col("f_cvd_proxy_24h", "flow", "candles"),
  col("f_cvd_proxy_7d", "flow", "candles"),
  col("f_cvd_real_24h", "flow", "live"),
  col("f_cvd_real_7d", "flow", "live"),
  col("f_book_imbalance", "flow", "live"),
  col("e_hours_to_fomc", "events", "events"),
  col("e_hours_since_fomc", "events", "events"),
  col("e_fomc_within_7d", "events", "events", "bool" as const),
  col("e_hours_to_cpi", "events", "events"),
  col("e_hours_since_cpi", "events", "events"),
  col("e_cpi_within_7d", "events", "events", "bool" as const),
  col("e_news_gate", "events", "live", "bool" as const),
  col("s_fng", "sentiment", "external"),
  col("s_fng_chg_7d", "sentiment", "external"),
] as const;

export type FeatureName = (typeof FEATURE_COLUMNS)[number]["name"];
type Col = (typeof FEATURE_COLUMNS)[number];
export type NumFeature = Extract<Col, { kind: "num" }>["name"];
export type BoolFeature = Extract<Col, { kind: "bool" }>["name"];
export type FeatureValues = Partial<Record<NumFeature, number | null> & Record<BoolFeature, boolean | null>>;
