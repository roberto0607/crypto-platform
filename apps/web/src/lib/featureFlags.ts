/**
 * Compile-time UI feature flags. Flip a value and rebuild to bring a feature back.
 */

/**
 * The order panel's leverage selector (1x/2x/3x/5x/10x). A client-side kill
 * switch only: even when true, the selector shows only where the server
 * allows more than 1x (GET /leverage: ISOLATED and cap > 1), offers only
 * values up to that cap, and sends `leverage` with the order. false = the
 * panel never shows leverage and never sends it (orders trade at 1x).
 */
export const SHOW_LEVERAGE_SELECTOR = true;

/**
 * The FUNDING rate in the chart's header row (the market's perp funding,
 * from FundingRatePanel's source). Hidden: TRADR charges no funding (leverage
 * v1), so showing a rate next to a leveraged position reads as a cost the
 * user pays. The FUNDING RATE sub-panel indicator is unaffected.
 */
export const SHOW_FUNDING_IN_CHART_HEADER = false;
