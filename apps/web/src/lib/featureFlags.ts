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
