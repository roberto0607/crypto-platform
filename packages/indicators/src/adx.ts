import type { Candle, Point } from "./types";
import { pineRma, pineTrueRange } from "./pine";

export interface ADXResult {
  plusDI: Point[];
  minusDI: Point[];
  adx: Point[];
}

/**
 * ADX and ±DI as TradingView's built-in "Average Directional Index" / DMI
 * (Wilder RMA throughout), inputs "DI Length" and "ADX Smoothing":
 *
 *   up = change(high), down = -change(low)
 *   +DM = up > down && up > 0 ? up : 0      (−DM symmetric)
 *   TR  = ta.tr (na on bar 0)
 *   ±DI = fixnan(100 * rma(±DM, diLength) / rma(TR, diLength))
 *   ADX = 100 * rma(|+DI − −DI| / (+DI + −DI, or 1 if 0), adxSmoothing)
 *
 * Bar 0 has no change, so ±DI start at bar `diLength` and ADX at bar
 * `diLength + adxSmoothing - 1`. No padding.
 */
export function computeADX(
  candles: Candle[],
  opts: { diLength?: number; adxSmoothing?: number } = {},
): ADXResult {
  const diLength = opts.diLength ?? 14;
  const adxSmoothing = opts.adxSmoothing ?? 14;
  const n = candles.length;
  const high = candles.map((c) => c.high);
  const low = candles.map((c) => c.low);
  const close = candles.map((c) => c.close);

  const plusDM = new Float64Array(n).fill(NaN);
  const minusDM = new Float64Array(n).fill(NaN);
  for (let i = 1; i < n; i++) {
    const up = high[i]! - high[i - 1]!;
    const down = low[i - 1]! - low[i]!;
    plusDM[i] = up > down && up > 0 ? up : 0;
    minusDM[i] = down > up && down > 0 ? down : 0;
  }
  const trRma = pineRma(pineTrueRange(high, low, close, false), diLength);
  const plusRma = pineRma(plusDM, diLength);
  const minusRma = pineRma(minusDM, diLength);

  // fixnan: a division by zero (na in Pine) keeps the last DI value.
  const plus = new Float64Array(n).fill(NaN);
  const minus = new Float64Array(n).fill(NaN);
  const dx = new Float64Array(n).fill(NaN);
  let lastPlus = NaN;
  let lastMinus = NaN;
  for (let i = 0; i < n; i++) {
    const tr = trRma[i]!;
    if (!Number.isNaN(tr) && tr !== 0) {
      lastPlus = (100 * plusRma[i]!) / tr;
      lastMinus = (100 * minusRma[i]!) / tr;
    }
    plus[i] = lastPlus;
    minus[i] = lastMinus;
    if (!Number.isNaN(lastPlus) && !Number.isNaN(lastMinus)) {
      const sum = lastPlus + lastMinus;
      dx[i] = Math.abs(lastPlus - lastMinus) / (sum === 0 ? 1 : sum);
    }
  }
  const adxRma = pineRma(dx, adxSmoothing);

  const result: ADXResult = { plusDI: [], minusDI: [], adx: [] };
  for (let i = 0; i < n; i++) {
    const t = candles[i]!.time;
    if (!Number.isNaN(plus[i]!)) {
      result.plusDI.push({ time: t, value: plus[i]! });
      result.minusDI.push({ time: t, value: minus[i]! });
    }
    if (!Number.isNaN(adxRma[i]!)) result.adx.push({ time: t, value: 100 * adxRma[i]! });
  }
  return result;
}
