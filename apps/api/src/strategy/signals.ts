import type {
  Candle,
  EntrySignal,
  IndicatorSnapshot,
  LiquidityLevels,
  PendingSetup,
  Regime,
  SweepType,
} from "./types.js";

// ── Bias Check ───────────────────────────────────────────────
// Spec L1: TREND_UP, or RANGE + below VWAP + in bottom 30% of daily range.
// Spec S1: TREND_DOWN, or RANGE + above VWAP + in top 30% of daily range.

function longBiasOk(
  regime: Regime,
  close: number,
  vwap: number,
  pdh: number,
  pdl: number,
): boolean {
  if (regime === "TREND_UP") return true;
  if (regime === "RANGE") {
    return close < vwap && close <= pdl + 0.30 * (pdh - pdl);
  }
  return false;
}

function shortBiasOk(
  regime: Regime,
  close: number,
  vwap: number,
  pdh: number,
  pdl: number,
): boolean {
  if (regime === "TREND_DOWN") return true;
  if (regime === "RANGE") {
    return close > vwap && close >= pdl + 0.70 * (pdh - pdl);
  }
  return false;
}

// ── Sweep Detection ──────────────────────────────────────────
// Spec L2: wick below level AND close >= level (reversal sweep down).
// Spec S2: wick above level AND close <= level (reversal sweep up).

interface SweepResult {
  sweepLevel: number;
  sweepType: SweepType;
}

function detectLongSweep(
  candle: Candle,
  liq: LiquidityLevels,
): SweepResult | null {
  // Check PDL first (higher priority — structural level)
  if (candle.low < liq.pdl && candle.close >= liq.pdl) {
    return { sweepLevel: liq.pdl, sweepType: "PDL" };
  }
  // Check EQL
  if (liq.eql !== null && candle.low < liq.eql.level && candle.close >= liq.eql.level) {
    return { sweepLevel: liq.eql.level, sweepType: "EQL" };
  }
  return null;
}

function detectShortSweep(
  candle: Candle,
  liq: LiquidityLevels,
): SweepResult | null {
  // Check PDH first
  if (candle.high > liq.pdh && candle.close <= liq.pdh) {
    return { sweepLevel: liq.pdh, sweepType: "PDH" };
  }
  // Check EQH
  if (liq.eqh !== null && candle.high > liq.eqh.level && candle.close <= liq.eqh.level) {
    return { sweepLevel: liq.eqh.level, sweepType: "EQH" };
  }
  return null;
}

// ── Swing Levels ─────────────────────────────────────────────
// Spec L4/S4: swing from candles [t0-5 .. t0-1].

function swingHigh(candles: Candle[], t0: number): number | null {
  let high = -Infinity;
  for (let i = t0 - 5; i <= t0 - 1; i++) {
    if (i < 0) continue;
    if (candles[i].high > high) high = candles[i].high;
  }
  return high === -Infinity ? null : high;
}

function swingLow(candles: Candle[], t0: number): number | null {
  let low = Infinity;
  for (let i = t0 - 5; i <= t0 - 1; i++) {
    if (i < 0) continue;
    if (candles[i].low < low) low = candles[i].low;
  }
  return low === Infinity ? null : low;
}

// ── Scan for Long Setup ──────────────────────────────────────
// Scans a 15m candle array for a fully confirmed long entry.
// Returns the first valid EntrySignal or null.
//
// `candles` = 15m candles, oldest → newest, at least 30 candles.
// `regime`  = current regime from last 4H close.
// `liq`     = current liquidity levels.
// `vwapValue` = current VWAP_daily (must not be null).
// `atr14_15m` = current ATR(14) on 15m.

export function scanLongEntry(
  candles: Candle[],
  regime: Regime,
  liq: LiquidityLevels,
  vwapValue: number,
  atr14_15m: number,
): EntrySignal | null {
  if (regime !== "TREND_UP" && regime !== "RANGE") return null;

  const len = candles.length;

  for (let t0 = 5; t0 < len; t0++) {
    const c0 = candles[t0];

    // L1: bias check at t0
    if (!longBiasOk(regime, c0.close, vwapValue, liq.pdh, liq.pdl)) continue;

    // L2: sweep with reversal at t0
    const sweep = detectLongSweep(c0, liq);
    if (sweep === null) continue;

    // L3 + L4: grace window [t0, t0+1, t0+2]
    const swingH = swingHigh(candles, t0);
    if (swingH === null) continue;

    let vwapConfirmed = false;
    let bosConfirmed = false;
    let bosIndex = -1;

    const graceEnd = Math.min(t0 + 2, len - 1);
    for (let t = t0; t <= graceEnd; t++) {
      // L3: VWAP reclaim
      if (candles[t].close > vwapValue) vwapConfirmed = true;
      // L4: BOS
      if (!bosConfirmed && candles[t].close > swingH) {
        bosConfirmed = true;
        bosIndex = t;
      }
    }

    if (!vwapConfirmed || !bosConfirmed) continue;

    // L5: pullback within [bosIndex+1 .. bosIndex+4]
    const pullbackEnd = Math.min(bosIndex + 4, len - 1);
    for (let t = bosIndex + 1; t <= pullbackEnd; t++) {
      if (candles[t].low <= vwapValue + 0.25 * atr14_15m) {
        return {
          direction: "LONG",
          regime,
          entryPrice: candles[t].close,
          entryIndex: t,
          sweepLevel: sweep.sweepLevel,
          sweepType: sweep.sweepType,
          bosLevel: swingH,
          vwapAtEntry: vwapValue,
          atr14_15m,
        };
      }
    }

    // L5 window expired — setup invalidated, continue scanning
  }

  return null;
}

// ── Scan for Short Setup ─────────────────────────────────────
// Mirror of scanLongEntry.

export function scanShortEntry(
  candles: Candle[],
  regime: Regime,
  liq: LiquidityLevels,
  vwapValue: number,
  atr14_15m: number,
): EntrySignal | null {
  if (regime !== "TREND_DOWN" && regime !== "RANGE") return null;

  const len = candles.length;

  for (let t0 = 5; t0 < len; t0++) {
    const c0 = candles[t0];

    // S1: bias check at t0
    if (!shortBiasOk(regime, c0.close, vwapValue, liq.pdh, liq.pdl)) continue;

    // S2: sweep with reversal at t0
    const sweep = detectShortSweep(c0, liq);
    if (sweep === null) continue;

    // S3 + S4: grace window [t0, t0+1, t0+2]
    const swingL = swingLow(candles, t0);
    if (swingL === null) continue;

    let vwapConfirmed = false;
    let bosConfirmed = false;
    let bosIndex = -1;

    const graceEnd = Math.min(t0 + 2, len - 1);
    for (let t = t0; t <= graceEnd; t++) {
      // S3: VWAP rejection
      if (candles[t].close < vwapValue) vwapConfirmed = true;
      // S4: BOS
      if (!bosConfirmed && candles[t].close < swingL) {
        bosConfirmed = true;
        bosIndex = t;
      }
    }

    if (!vwapConfirmed || !bosConfirmed) continue;

    // S5: pullback within [bosIndex+1 .. bosIndex+4]
    const pullbackEnd = Math.min(bosIndex + 4, len - 1);
    for (let t = bosIndex + 1; t <= pullbackEnd; t++) {
      if (candles[t].high >= vwapValue - 0.25 * atr14_15m) {
        return {
          direction: "SHORT",
          regime,
          entryPrice: candles[t].close,
          entryIndex: t,
          sweepLevel: sweep.sweepLevel,
          sweepType: sweep.sweepType,
          bosLevel: swingL,
          vwapAtEntry: vwapValue,
          atr14_15m,
        };
      }
    }
  }

  return null;
}
