import Decimal from "decimal.js";

Decimal.set({ precision: 36, rounding: Decimal.ROUND_DOWN });

export const D = (v: string | number) => new Decimal(v);
export const ZERO = new Decimal(0);
export const BPS_DIVISOR = new Decimal(10000);

export function toFixed8(d: Decimal): string {
  return d.toFixed(8);
}
