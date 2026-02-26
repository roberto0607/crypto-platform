import type { PositionSizeResult } from "./types.js";

// Spec Section 9: Position Sizing Rule.
//
// account_risk_pct  = 0.01 (1%)
// risk_per_trade    = equity * 0.01
// R                 = abs(entry - SL)
// size_usd          = risk_per_trade / (R / entry)
// size_btc          = size_usd / entry
//
// Cap: max 5% of equity in a single position.
// Caller enforces max 2 concurrent open positions.

const ACCOUNT_RISK_PCT = 0.01;
const MAX_POSITION_PCT = 0.05;

export function computePositionSize(
  accountEquity: number,
  entryPrice: number,
  stopLoss: number,
): PositionSizeResult {
  const riskPerTrade = accountEquity * ACCOUNT_RISK_PCT;
  const r = Math.abs(entryPrice - stopLoss);

  // Guard: R must be positive to avoid division by zero
  if (r <= 0 || entryPrice <= 0) {
    return {
      riskPerTrade,
      r,
      positionSizeUsd: 0,
      positionSizeBtc: 0,
      capped: false,
    };
  }

  const maxPositionUsd = accountEquity * MAX_POSITION_PCT;
  let positionSizeUsd = riskPerTrade / (r / entryPrice);

  let capped = false;
  if (positionSizeUsd > maxPositionUsd) {
    positionSizeUsd = maxPositionUsd;
    capped = true;
  }

  const positionSizeBtc = positionSizeUsd / entryPrice;

  return {
    riskPerTrade,
    r,
    positionSizeUsd,
    positionSizeBtc,
    capped,
  };
}
