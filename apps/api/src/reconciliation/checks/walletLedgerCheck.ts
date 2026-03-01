import { pool } from "../../db/pool";
import { D, ZERO, toFixed8 } from "../../utils/decimal";
import type { ReconFinding } from "../reconTypes";

const EPS = D("0.00000001");

// ── Wallet balance vs ledger SUM ──

const WALLET_LEDGER_SQL = `
  SELECT
    w.id          AS wallet_id,
    w.user_id,
    w.balance     AS actual_balance,
    COALESCE(agg.ledger_net, 0)::NUMERIC(28,8) AS ledger_net
  FROM wallets w
  LEFT JOIN (
    SELECT wallet_id, SUM(amount) AS ledger_net
    FROM ledger_entries
    GROUP BY wallet_id
  ) agg ON agg.wallet_id = w.id
`;

// ── Latest balance_after vs wallet balance ──

const LATEST_BALANCE_AFTER_SQL = `
  SELECT DISTINCT ON (le.wallet_id)
    le.wallet_id,
    w.user_id,
    w.balance     AS actual_balance,
    le.balance_after
  FROM ledger_entries le
  JOIN wallets w ON w.id = le.wallet_id
  ORDER BY le.wallet_id, le.created_at DESC
`;

// ── Check ──

export async function walletLedgerCheck(): Promise<ReconFinding[]> {
  const findings: ReconFinding[] = [];

  // C1a: wallet.balance vs SUM(ledger_entries.amount)
  const { rows: balanceRows } = await pool.query(WALLET_LEDGER_SQL);

  for (const row of balanceRows) {
    const actual = D(row.actual_balance);
    const ledgerNet = D(row.ledger_net);
    const diff = actual.minus(ledgerNet).abs();

    if (diff.gt(EPS)) {
      findings.push({
        severity: "HIGH",
        checkName: "WALLET_LEDGER_MISMATCH",
        userId: row.user_id,
        details: {
          walletId: row.wallet_id,
          balance: toFixed8(actual),
          ledgerNet: toFixed8(ledgerNet),
          diff: toFixed8(diff),
        },
      });
    }
  }

  // C1b: latest ledger_entry.balance_after vs wallet.balance
  const { rows: afterRows } = await pool.query(LATEST_BALANCE_AFTER_SQL);

  for (const row of afterRows) {
    const actual = D(row.actual_balance);
    const balanceAfter = D(row.balance_after);
    const diff = actual.minus(balanceAfter).abs();

    if (diff.gt(EPS)) {
      findings.push({
        severity: "HIGH",
        checkName: "WALLET_LEDGER_MISMATCH",
        userId: row.user_id,
        details: {
          walletId: row.wallet_id,
          balance: toFixed8(actual),
          latestBalanceAfter: toFixed8(balanceAfter),
          diff: toFixed8(diff),
          subcheck: "BALANCE_AFTER",
        },
      });
    }
  }

  return findings;
}
