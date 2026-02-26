// ── Execution Model Constants ───────────────────────────────
// Step 2: Slippage, fees, and fill assumptions.

export const SLIPPAGE_BPS = 5;
export const TAKER_FEE_BPS = 10;

// ── Slippage Application ────────────────────────────────────
// Slippage always works AGAINST the trader.
// Long entry: slipped up. Long exit: slipped down.
// Short entry: slipped down. Short exit: slipped up.

export function applySlippage(
  price: number,
  direction: "LONG" | "SHORT",
  side: "ENTRY" | "EXIT",
): number {
  const multiplier = SLIPPAGE_BPS / 10_000;

  if (direction === "LONG") {
    return side === "ENTRY"
      ? price * (1 + multiplier)
      : price * (1 - multiplier);
  } else {
    return side === "ENTRY"
      ? price * (1 - multiplier)
      : price * (1 + multiplier);
  }
}

// ── Fee Calculation ─────────────────────────────────────────
// Taker fee per leg. Round-trip = 2 × TAKER_FEE_BPS = 20 bps.

export function computeFee(positionSizeUsd: number): number {
  return positionSizeUsd * (TAKER_FEE_BPS / 10_000);
}

// ── Net P&L After Costs ─────────────────────────────────────
// Deducts entry fee + exit fee from gross P&L.

export function netPnl(
  grossPnl: number,
  entrySizeUsd: number,
  exitSizeUsd: number,
): number {
  return grossPnl - computeFee(entrySizeUsd) - computeFee(exitSizeUsd);
}
