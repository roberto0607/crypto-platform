import type { IndicatorSnapshot, Regime } from "./types.js";

// Spec Section 3: Regime Classification Rules.
// Evaluated once per 4H candle close.

export function classifyRegime(
  snap: IndicatorSnapshot,
  adxThreshold: number = 20,
): Regime {
  const { ema20_4H, ema50_4H, adx14_4H, atr14_4H, close4H } = snap;

  // Guard: ATR must be positive to compute EMA distance ratio
  if (atr14_4H <= 0) return "NO_TRADE";

  const emaDistRatio = Math.abs(ema20_4H - ema50_4H) / atr14_4H;

  // TREND_UP
  if (close4H > ema20_4H && ema20_4H > ema50_4H && adx14_4H >= adxThreshold) {
    return "TREND_UP";
  }

  // TREND_DOWN
  if (close4H < ema20_4H && ema20_4H < ema50_4H && adx14_4H >= adxThreshold) {
    return "TREND_DOWN";
  }

  // RANGE
  if (adx14_4H < adxThreshold && emaDistRatio < 0.5) {
    return "RANGE";
  }

  // NO_TRADE (none of the above)
  return "NO_TRADE";
}
