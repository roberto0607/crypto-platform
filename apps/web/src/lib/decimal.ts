import Decimal from "decimal.js-light";
import type { DecimalString } from "@/types/api";

/**
 * Format a decimal string with commas and fixed decimal places.
 * Default: 2 for fiat, 8 for crypto.
 */
export function formatDecimal(value: DecimalString, decimals = 2): string {
  const d = new Decimal(value);
  const fixed = d.toFixed(decimals);
  const [intPart, fracPart] = fixed.split(".");
  const withCommas = (intPart ?? "0").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return fracPart !== undefined ? `${withCommas}.${fracPart}` : withCommas;
}

/** Format as USD: $1,234.56 */
export function formatUsd(value: DecimalString): string {
  const d = new Decimal(value);
  const prefix = d.isNegative() ? "-$" : "$";
  return `${prefix}${formatDecimal(d.abs().toString(), 2)}`;
}

/** Format as crypto: 0.12345678 BTC */
export function formatCrypto(value: DecimalString, symbol: string): string {
  return `${formatDecimal(value, 8)} ${symbol}`;
}

/** Format as percentage: +12.34% or -5.67% */
export function formatPct(value: DecimalString): string {
  const d = new Decimal(value);
  const sign = d.isPositive() ? "+" : "";
  return `${sign}${d.toFixed(2)}%`;
}

/** Validate and normalize a decimal input string */
export function parseDecimal(value: string): DecimalString {
  const cleaned = value.replace(/,/g, "").trim();
  // Throws if invalid
  const d = new Decimal(cleaned);
  return d.toString();
}
