import type { Candle, Timeframe } from "./types.js";
import type { DataValidationError, DataValidationResult } from "./backtestTypes.js";
import { CANDLE_INTERVAL_MS, CANDLES_15M_PER, WARMUP } from "./backtestTypes.js";

// ── Gap tolerance ───────────────────────────────────────────
// Allow up to 60 seconds drift for timestamp precision issues.
const GAP_TOLERANCE_MS = 60_000;

// ── Validate a single candle feed ───────────────────────────
// Checks: monotonic timestamps, no gaps, OHLC sanity, non-negative volume.

export function validateCandleFeed(
  candles: Candle[],
  timeframe: Timeframe,
): DataValidationError[] {
  const errors: DataValidationError[] = [];
  const intervalMs = CANDLE_INTERVAL_MS[timeframe];

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];

    // OHLC sanity: low must be <= open,close and high must be >= open,close
    if (c.low > Math.min(c.open, c.close) || c.high < Math.max(c.open, c.close)) {
      errors.push({
        code: "OHLC_VIOLATION",
        message: `Candle ${i}: low=${c.low} open=${c.open} close=${c.close} high=${c.high}`,
        index: i,
        timestamp: c.timestamp,
      });
    }

    // Non-negative volume
    if (c.volume < 0) {
      errors.push({
        code: "NEGATIVE_VOLUME",
        message: `Candle ${i}: volume=${c.volume}`,
        index: i,
        timestamp: c.timestamp,
      });
    }

    if (i === 0) continue;

    const prevMs = new Date(candles[i - 1].timestamp).getTime();
    const currMs = new Date(c.timestamp).getTime();

    // Monotonic timestamps (strictly increasing)
    if (currMs <= prevMs) {
      errors.push({
        code: "NON_MONOTONIC",
        message: `Candle ${i}: ${c.timestamp} <= previous ${candles[i - 1].timestamp}`,
        index: i,
        timestamp: c.timestamp,
      });
    }

    // Gap detection
    const expectedMs = prevMs + intervalMs;
    const drift = Math.abs(currMs - expectedMs);
    if (drift > GAP_TOLERANCE_MS) {
      errors.push({
        code: "DATA_GAP",
        message: `Candle ${i}: expected ~${new Date(expectedMs).toISOString()}, got ${c.timestamp} (drift ${drift}ms)`,
        index: i,
        timestamp: c.timestamp,
      });
    }
  }

  return errors;
}

// ── Validate warmup coverage ────────────────────────────────
// Checks that enough 4H candles exist before the first tradeable 15m candle.

export function validateWarmup(
  candles15m: Candle[],
  candles4H: Candle[],
  candles1D: Candle[],
): DataValidationError[] {
  const errors: DataValidationError[] = [];

  if (candles15m.length === 0 || candles4H.length === 0 || candles1D.length === 0) {
    errors.push({
      code: "INSUFFICIENT_WARMUP",
      message: "One or more candle feeds are empty.",
    });
    return errors;
  }

  // Count 4H candles that close before or at the first tradeable 15m candle.
  // Tradeable 15m window starts after warmup. We need the 4H feed to have
  // BINDING_4H_CANDLES completed before signals can fire.
  if (candles4H.length < WARMUP.BINDING_4H_CANDLES) {
    errors.push({
      code: "INSUFFICIENT_WARMUP",
      message: `Only ${candles4H.length} 4H candles provided. Need >= ${WARMUP.BINDING_4H_CANDLES} for EMA(50) warmup.`,
    });
  }

  // ATR(14) on 15m needs 15 candles
  if (candles15m.length < WARMUP.ATR_14_15M) {
    errors.push({
      code: "INSUFFICIENT_WARMUP",
      message: `Only ${candles15m.length} 15m candles provided. Need >= ${WARMUP.ATR_14_15M} for ATR(14) warmup.`,
    });
  }

  // Daily candles: need at least 1 completed day for PDH/PDL
  if (candles1D.length < 1) {
    errors.push({
      code: "INSUFFICIENT_WARMUP",
      message: "Need >= 1 daily candle for PDH/PDL.",
    });
  }

  return errors;
}

// ── Full backtest data validation ───────────────────────────
// Validates all three feeds, warmup, and computes tradeable range.

export function validateBacktestData(
  candles15m: Candle[],
  candles4H: Candle[],
  candles1D: Candle[],
): DataValidationResult {
  const errors: DataValidationError[] = [];

  // Per-feed integrity
  errors.push(...validateCandleFeed(candles15m, "15m"));
  errors.push(...validateCandleFeed(candles4H, "4H"));
  errors.push(...validateCandleFeed(candles1D, "1D"));

  // Warmup coverage
  errors.push(...validateWarmup(candles15m, candles4H, candles1D));

  // Tradeable candles: total 15m minus warmup-equivalent 15m candles
  // Warmup = BINDING_4H_CANDLES × (15m candles per 4H period)
  const warmup15m = WARMUP.BINDING_4H_CANDLES * CANDLES_15M_PER["4H"];
  const tradeableCandles15m = Math.max(0, candles15m.length - warmup15m);
  const tradeableDays = tradeableCandles15m / CANDLES_15M_PER["1D"];

  return {
    valid: errors.length === 0,
    errors,
    tradeableCandles15m,
    tradeableDays,
  };
}
