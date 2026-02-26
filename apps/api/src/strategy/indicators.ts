import type { Candle, VwapState } from "./types.js";

// ── VWAP ─────
// Spec Section 2: tp = (H + L + C) / 3
// VWAP = sum(tp * vol) / sum(vol) from 00:00 UTC.
//
// Call resetVwap() at 00:00 UTC, then updateVwap() on each 15m candle close.

export function resetVwap(): VwapState {
  return { cumulativeTpVol: 0, cumulativeVol: 0, value: null };
}

export function updateVwap(state: VwapState, candle: Candle): VwapState {
  const tp = (candle.high + candle.low + candle.close) / 3;
  const cumulativeTpVol = state.cumulativeTpVol + tp * candle.volume;
  const cumulativeVol = state.cumulativeVol + candle.volume;

  const value = cumulativeVol > 0 ? cumulativeTpVol / cumulativeVol : null;

  return { cumulativeTpVol, cumulativeVol, value };
}

// ── EMA ──────────────────────────────────────────────────────
// Standard exponential moving average.
// `closes` ordered oldest → newest. Returns final EMA value.
// Returns null if closes.length < period.

export function ema(closes: number[], period: number): number | null {
  if (closes.length < period) return null;

  const k = 2 / (period + 1);

  // Seed: SMA of first `period` values
  let value = 0;
  for (let i = 0; i < period; i++) {
    value += closes[i];
  }
  value /= period;

  // EMA from period onward
  for (let i = period; i < closes.length; i++) {
    value = closes[i] * k + value * (1 - k);
  }

  return value;
}

// ── ATR ──────────────────────────────────────────────────────
// Average True Range (Wilder smoothing).
// `candles` ordered oldest → newest. Returns final ATR value.
// Returns null if candles.length < period + 1 (need prior close).

export function atr(candles: Candle[], period: number): number | null {
  if (candles.length < period + 1) return null;

  // True range for candle i (i >= 1)
  function tr(i: number): number {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1].close;
    return Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
  }

  // Seed: simple average of first `period` TR values (indices 1..period)
  let value = 0;
  for (let i = 1; i <= period; i++) {
    value += tr(i);
  }
  value /= period;

  // Wilder smoothing from period+1 onward
  for (let i = period + 1; i < candles.length; i++) {
    value = (value * (period - 1) + tr(i)) / period;
  }

  return value;
}

// ── ADX ───
// Average Directional Index (Wilder, 14-period standard).
// `candles` ordered oldest → newest. Returns final ADX value.
// Requires at least 2 * period + 1 candles.

export function adx(candles: Candle[], period: number): number | null {
  if (candles.length < 2 * period + 1) return null;

  function tr(i: number): number {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1].close;
    return Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
  }

  function plusDm(i: number): number {
    const upMove = candles[i].high - candles[i - 1].high;
    const downMove = candles[i - 1].low - candles[i].low;
    return upMove > downMove && upMove > 0 ? upMove : 0;
  }

  function minusDm(i: number): number {
    const upMove = candles[i].high - candles[i - 1].high;
    const downMove = candles[i - 1].low - candles[i].low;
    return downMove > upMove && downMove > 0 ? downMove : 0;
  }

  // Seed smoothed TR, +DM, -DM over first `period` bars (indices 1..period)
  let smoothTr = 0;
  let smoothPlusDm = 0;
  let smoothMinusDm = 0;
  for (let i = 1; i <= period; i++) {
    smoothTr += tr(i);
    smoothPlusDm += plusDm(i);
    smoothMinusDm += minusDm(i);
  }

  // Wilder-smooth TR, +DM, -DM from period+1 onward and collect DX values
  const dxValues: number[] = [];

  // First DX from seed
  const plusDi0 = smoothTr > 0 ? (smoothPlusDm / smoothTr) * 100 : 0;
  const minusDi0 = smoothTr > 0 ? (smoothMinusDm / smoothTr) * 100 : 0;
  const diSum0 = plusDi0 + minusDi0;
  if (diSum0 > 0) dxValues.push((Math.abs(plusDi0 - minusDi0) / diSum0) * 100);

  for (let i = period + 1; i < candles.length; i++) {
    smoothTr = smoothTr - smoothTr / period + tr(i);
    smoothPlusDm = smoothPlusDm - smoothPlusDm / period + plusDm(i);
    smoothMinusDm = smoothMinusDm - smoothMinusDm / period + minusDm(i);

    const plusDi = smoothTr > 0 ? (smoothPlusDm / smoothTr) * 100 : 0;
    const minusDi = smoothTr > 0 ? (smoothMinusDm / smoothTr) * 100 : 0;
    const diSum = plusDi + minusDi;

    if (diSum > 0) {
      dxValues.push((Math.abs(plusDi - minusDi) / diSum) * 100);
    }
  }

  if (dxValues.length < period) return null;

  // ADX: first ADX = SMA of first `period` DX values, then Wilder-smooth
  let adxValue = 0;
  for (let i = 0; i < period; i++) {
    adxValue += dxValues[i];
  }
  adxValue /= period;

  for (let i = period; i < dxValues.length; i++) {
    adxValue = (adxValue * (period - 1) + dxValues[i]) / period;
  }

  return adxValue;
}