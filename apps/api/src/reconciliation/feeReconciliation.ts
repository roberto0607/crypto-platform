import { pool } from "../db/pool";
import { D, ZERO, BPS_DIVISOR, toFixed8 } from "../utils/decimal";

// ── Types ──

export interface FeeMismatch {
  tradeId: string;
  pairSymbol: string;
  expectedFee: string;
  actualFee: string;
  delta: string;
  quoteAmount: string;
  feeBps: number;
}

export interface FeeReconciliationReport {
  tradesChecked: number;
  mismatchedFees: FeeMismatch[];
  negativeFees: string[];
  missingFeeEntries: string[];
}

// ── Query ──

const TRADES_WITH_FEES_SQL = `
  SELECT
    t.id           AS trade_id,
    t.quote_amount::text AS quote_amount,
    t.fee_amount::text   AS fee_amount,
    t.is_system_fill,
    tp.symbol      AS pair_symbol,
    tp.taker_fee_bps
  FROM trades t
  JOIN trading_pairs tp ON tp.id = t.pair_id
  ORDER BY t.executed_at ASC
`;

// ── Reconciliation ──

export async function reconcileFees(): Promise<FeeReconciliationReport> {
  const { rows } = await pool.query(TRADES_WITH_FEES_SQL);

  const mismatchedFees: FeeMismatch[] = [];
  const negativeFees: string[] = [];
  const missingFeeEntries: string[] = [];

  for (const row of rows) {
    const actualFee = D(row.fee_amount);
    const quoteAmount = D(row.quote_amount);
    const bps = row.taker_fee_bps as number;

    // Check negative fee
    if (actualFee.lt(ZERO)) {
      negativeFees.push(row.trade_id);
      continue;
    }

    // Check missing fee: non-zero quote but zero fee (and bps > 0)
    if (actualFee.eq(ZERO) && quoteAmount.gt(ZERO) && bps > 0) {
      missingFeeEntries.push(row.trade_id);
      continue;
    }

    // Recompute expected fee: quoteAmount * taker_fee_bps / 10000
    const expectedFee = quoteAmount.mul(D(bps)).div(BPS_DIVISOR);
    const expectedFeeStr = toFixed8(expectedFee);
    const actualFeeStr = toFixed8(actualFee);

    if (expectedFeeStr !== actualFeeStr) {
      mismatchedFees.push({
        tradeId: row.trade_id,
        pairSymbol: row.pair_symbol,
        expectedFee: expectedFeeStr,
        actualFee: actualFeeStr,
        delta: toFixed8(expectedFee.minus(actualFee)),
        quoteAmount: toFixed8(quoteAmount),
        feeBps: bps,
      });
    }
  }

  return {
    tradesChecked: rows.length,
    mismatchedFees,
    negativeFees,
    missingFeeEntries,
  };
}

