import type {
  Candle,
  InvalidationReason,
  LiquidityLevels,
  PendingSetup,
  Regime,
} from "./types.js";

// Spec Section 10: Trade Invalidation Rules.
// Checked on every 15m candle close while a PendingSetup exists
// but L5/S5 has NOT yet fired.

// ── I1: Regime Change ────────────────────────────────────────
// New 4H close produced a different regime than the setup's regime.

export function checkRegimeChange(
  setup: PendingSetup,
  currentRegime: Regime,
): InvalidationReason | null {
  if (currentRegime !== setup.regime) return "REGIME_CHANGE";
  return null;
}

// ── I2: Price Distance ───────────────────────────────────────
// Price moved > 2.0 * ATR away from sweep level before pullback.
// Long: close > sweepLevel + 2.0 * ATR.
// Short: close < sweepLevel - 2.0 * ATR.

export function checkPriceDistance(
  setup: PendingSetup,
  candleClose: number,
  atr14_15m: number,
): InvalidationReason | null {
  const threshold = 2.0 * atr14_15m;

  if (setup.direction === "LONG") {
    if (candleClose > setup.sweepLevel + threshold) return "PRICE_DISTANCE";
  } else {
    if (candleClose < setup.sweepLevel - threshold) return "PRICE_DISTANCE";
  }

  return null;
}

// ── I3: Window Expired ───────────────────────────────────────
// More than 4 candles after BOS without pullback entry triggering.
// `currentIndex` = index of current candle being evaluated.
// `bosIndex` = index where L4/S4 fired (null if BOS not yet confirmed).

export function checkWindowExpired(
  bosIndex: number | null,
  currentIndex: number,
): InvalidationReason | null {
  if (bosIndex === null) return null;
  if (currentIndex > bosIndex + 4) return "WINDOW_EXPIRED";
  return null;
}

// ── I4: Opposing Sweep ───────────────────────────────────────
// Long setup active but a short sweep occurs (wick above PDH/EQH + close back below).
// Short setup active but a long sweep occurs (wick below PDL/EQL + close back above).

export function checkOpposingSweep(
  setup: PendingSetup,
  candle: Candle,
  liq: LiquidityLevels,
): InvalidationReason | null {
  if (setup.direction === "LONG") {
    // Opposing = short-style sweep (above PDH or EQH with reversal)
    if (candle.high > liq.pdh && candle.close <= liq.pdh) {
      return "OPPOSING_SWEEP";
    }
    if (liq.eqh !== null && candle.high > liq.eqh.level && candle.close <= liq.eqh.level) {
      return "OPPOSING_SWEEP";
    }
  } else {
    // Opposing = long-style sweep (below PDL or EQL with reversal)
    if (candle.low < liq.pdl && candle.close >= liq.pdl) {
      return "OPPOSING_SWEEP";
    }
    if (liq.eql !== null && candle.low < liq.eql.level && candle.close >= liq.eql.level) {
      return "OPPOSING_SWEEP";
    }
  }

  return null;
}

// ── I5: Momentum Collapse ────────────────────────────────────
// ADX drops below 15 during a TREND regime setup.
// Only applies when setup.regime is TREND_UP or TREND_DOWN.

export function checkMomentumCollapse(
  setup: PendingSetup,
  adx14_4H: number,
): InvalidationReason | null {
  if (setup.regime !== "TREND_UP" && setup.regime !== "TREND_DOWN") return null;
  if (adx14_4H < 15) return "MOMENTUM_COLLAPSE";
  return null;
}

// ── I6: Candle Range Filter ──────────────────────────────────
// Entry candle (L5/S5) range exceeds 3.0 * ATR.
// Called only at the moment of intended entry, not during scanning.

export function checkCandleRangeFilter(
  candle: Candle,
  atr14_15m: number,
): InvalidationReason | null {
  const range = candle.high - candle.low;
  if (range > 3.0 * atr14_15m) return "CANDLE_RANGE_FILTER";
  return null;
}

// ── Run All Invalidation Checks ──────────────────────────────
// Convenience: runs I1–I5 against a pending setup on each candle close.
// I6 is intentionally excluded — it runs only at entry time.
// Returns the first triggered reason, or null if setup remains valid.

export function checkInvalidation(
  setup: PendingSetup,
  currentRegime: Regime,
  candle: Candle,
  candleIndex: number,
  atr14_15m: number,
  adx14_4H: number,
  liq: LiquidityLevels,
): InvalidationReason | null {
  return (
    checkRegimeChange(setup, currentRegime) ??
    checkPriceDistance(setup, candle.close, atr14_15m) ??
    checkWindowExpired(setup.bosIndex, candleIndex) ??
    checkOpposingSweep(setup, candle, liq) ??
    checkMomentumCollapse(setup, adx14_4H)
  );
}
