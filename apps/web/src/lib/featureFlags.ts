/**
 * Compile-time UI feature flags. Flip a value and rebuild to bring a feature back.
 */

/**
 * The 1x/2x/3x/5x/10x selector in the order panel. Hidden until real leverage
 * UI ships: the old buttons never applied leverage, they only multiplied qty
 * into a bigger spot order. Showing the selector does NOT change order size —
 * sizing is always exactly the amount entered — so wire real leverage into the
 * order request before turning this on.
 */
export const SHOW_LEVERAGE_SELECTOR = false;
