import { pool } from "../../db/pool";
import { D, toFixed8 } from "../../utils/decimal";
import type { ReconFinding } from "../reconTypes";

const EPS = D("0.00000001");

// ── Per-trade base/quote net from ledger entries ──

const TRADE_CONSERVATION_SQL = `
  SELECT
    t.id            AS trade_id,
    t.fee_amount::text AS fee_amount,
    tp.base_asset_id,
    tp.quote_asset_id,
    COALESCE(SUM(le.amount) FILTER (WHERE w.asset_id = tp.base_asset_id), 0)::NUMERIC(28,8)  AS base_net,
    COALESCE(SUM(le.amount) FILTER (WHERE w.asset_id = tp.quote_asset_id), 0)::NUMERIC(28,8) AS quote_net
  FROM trades t
  JOIN trading_pairs tp ON tp.id = t.pair_id
  LEFT JOIN ledger_entries le
    ON le.reference_type = 'TRADE' AND le.reference_id = t.id
  LEFT JOIN wallets w ON w.id = le.wallet_id
  GROUP BY t.id, t.fee_amount, tp.base_asset_id, tp.quote_asset_id
`;

// ── Check ──

export async function tradeConservationCheck(): Promise<ReconFinding[]> {
  const findings: ReconFinding[] = [];

  const { rows } = await pool.query(TRADE_CONSERVATION_SQL);

  for (const row of rows) {
    const baseNet = D(row.base_net);
    const quoteNet = D(row.quote_net);
    const feeAmount = D(row.fee_amount);

    // Base net across both parties should be ≈ 0
    if (baseNet.abs().gt(EPS)) {
      findings.push({
        severity: "HIGH",
        checkName: "TRADE_CONSERVATION_FAIL",
        userId: null,
        details: {
          tradeId: row.trade_id,
          baseNet: toFixed8(baseNet),
          quoteNet: toFixed8(quoteNet),
          feeAmount: toFixed8(feeAmount),
          subcheck: "BASE",
        },
      });
    }

    // Quote net should be ≈ -fee_amount (fee is "burned")
    const expectedQuoteNet = feeAmount.negated();
    const quoteDiff = quoteNet.minus(expectedQuoteNet).abs();

    if (quoteDiff.gt(EPS)) {
      findings.push({
        severity: "HIGH",
        checkName: "TRADE_CONSERVATION_FAIL",
        userId: null,
        details: {
          tradeId: row.trade_id,
          baseNet: toFixed8(baseNet),
          quoteNet: toFixed8(quoteNet),
          expectedQuoteNet: toFixed8(expectedQuoteNet),
          feeAmount: toFixed8(feeAmount),
          subcheck: "QUOTE",
        },
      });
    }
  }

  return findings;
}
