import { pool } from "../db/pool";
import { D, ZERO, toFixed8 } from "../utils/decimal";

// ── Types ──

export interface WalletMismatch {
  walletId: string;
  userId: string;
  assetSymbol: string;
  expected: string;
  actual: string;
  delta: string;
}

export interface InvalidReservedWallet {
  walletId: string;
  userId: string;
  assetSymbol: string;
  balance: string;
  reserved: string;
  reason: "NEGATIVE_RESERVED" | "RESERVED_EXCEEDS_BALANCE";
}

export interface WalletReconciliationReport {
  totalWalletsChecked: number;
  mismatchedWallets: WalletMismatch[];
  invalidReservedWallets: InvalidReservedWallet[];
}

// ── Query ──

const WALLET_LEDGER_SQL = `
  SELECT
    w.id          AS wallet_id,
    w.user_id,
    a.symbol      AS asset_symbol,
    w.balance     AS actual_balance,
    w.reserved,
    COALESCE(l.expected_balance, '0.00000000') AS expected_balance
  FROM wallets w
  JOIN assets a ON a.id = w.asset_id
  LEFT JOIN (
    SELECT wallet_id,
           SUM(amount)::NUMERIC(28,8) AS expected_balance
    FROM ledger_entries
    GROUP BY wallet_id
  ) l ON l.wallet_id = w.id
`;

// ── Reconciliation ──

export async function reconcileWallets(): Promise<WalletReconciliationReport> {
  const { rows } = await pool.query(WALLET_LEDGER_SQL);

  const mismatchedWallets: WalletMismatch[] = [];
  const invalidReservedWallets: InvalidReservedWallet[] = [];

  for (const row of rows) {
    const expected = D(row.expected_balance);
    const actual = D(row.actual_balance);

    if (!expected.eq(actual)) {
      mismatchedWallets.push({
        walletId: row.wallet_id,
        userId: row.user_id,
        assetSymbol: row.asset_symbol,
        expected: toFixed8(expected),
        actual: toFixed8(actual),
        delta: toFixed8(expected.minus(actual)),
      });
    }

    const reserved = D(row.reserved);
    const balance = D(row.actual_balance);

    if (reserved.lt(ZERO)) {
      invalidReservedWallets.push({
        walletId: row.wallet_id,
        userId: row.user_id,
        assetSymbol: row.asset_symbol,
        balance: toFixed8(balance),
        reserved: toFixed8(reserved),
        reason: "NEGATIVE_RESERVED",
      });
    } else if (reserved.gt(balance)) {
      invalidReservedWallets.push({
        walletId: row.wallet_id,
        userId: row.user_id,
        assetSymbol: row.asset_symbol,
        balance: toFixed8(balance),
        reserved: toFixed8(reserved),
        reason: "RESERVED_EXCEEDS_BALANCE",
      });
    }
  }

  return {
    totalWalletsChecked: rows.length,
    mismatchedWallets,
    invalidReservedWallets,
  };
}
