import type { Pool } from "pg";
import { hashPassword } from "../auth/password";

const DEFAULT_PASSWORD = "TestPass1234";

/* ── Users ─────────────────────────────────────────────── */

export async function createTestUser(
  pool: Pool,
  overrides: { email?: string; role?: string; password?: string } = {},
) {
  const suffix = Math.random().toString(36).slice(2, 8);
  const email = overrides.email ?? `test-${suffix}@test.com`;
  const emailNormalized = email.toLowerCase();
  const passwordHash = await hashPassword(overrides.password ?? DEFAULT_PASSWORD);
  const role = overrides.role ?? "USER";

  const { rows } = await pool.query<{ id: string; email: string; role: string }>(
    `INSERT INTO users (email, email_normalized, password_hash, role)
     VALUES ($1, $2, $3, $4)
     RETURNING id, email, role`,
    [email, emailNormalized, passwordHash, role],
  );

  return { ...rows[0], password: overrides.password ?? DEFAULT_PASSWORD };
}

/* ── Assets & trading pair ─────────────────────────────── */

export async function createTestAssetAndPair(pool: Pool) {
  const { rows: btcRows } = await pool.query<{ id: string; symbol: string }>(
    `INSERT INTO assets (symbol, name, decimals)
     VALUES ('BTC', 'Bitcoin', 8)
     RETURNING id, symbol`,
  );
  const { rows: usdRows } = await pool.query<{ id: string; symbol: string }>(
    `INSERT INTO assets (symbol, name, decimals)
     VALUES ('USD', 'US Dollar', 2)
     RETURNING id, symbol`,
  );

  const btcAsset = btcRows[0];
  const usdAsset = usdRows[0];

  const { rows: pairRows } = await pool.query<{
    id: string;
    symbol: string;
    maker_fee_bps: number;
    taker_fee_bps: number;
  }>(
    `INSERT INTO trading_pairs
       (base_asset_id, quote_asset_id, symbol, is_active, last_price, maker_fee_bps, taker_fee_bps)
     VALUES ($1, $2, 'BTC/USD', true, '50000.00000000', 2, 5)
     RETURNING id, symbol, maker_fee_bps, taker_fee_bps`,
    [btcAsset.id, usdAsset.id],
  );

  return { btcAsset, usdAsset, pair: pairRows[0] };
}

/* ── Wallets ───────────────────────────────────────────── */

export async function createTestWallets(
  pool: Pool,
  userId: string,
  btcAssetId: string,
  usdAssetId: string,
  btcBalance = "10.00000000",
  usdBalance = "100000.00000000",
) {
  const { rows: btcRows } = await pool.query<{ id: string }>(
    `INSERT INTO wallets (user_id, asset_id, balance, reserved)
     VALUES ($1, $2, $3, '0.00000000')
     RETURNING id`,
    [userId, btcAssetId, btcBalance],
  );
  const { rows: usdRows } = await pool.query<{ id: string }>(
    `INSERT INTO wallets (user_id, asset_id, balance, reserved)
     VALUES ($1, $2, $3, '0.00000000')
     RETURNING id`,
    [userId, usdAssetId, usdBalance],
  );

  return {
    btcWallet: { id: btcRows[0].id, balance: btcBalance, reserved: "0.00000000" },
    usdWallet: { id: usdRows[0].id, balance: usdBalance, reserved: "0.00000000" },
  };
}

/* ── Orders (direct DB seed, bypasses matching engine) ── */

export async function seedTestOrder(
  pool: Pool,
  userId: string,
  pairId: string,
  side: "BUY" | "SELL",
  type: "LIMIT" | "MARKET",
  qty: string,
  limitPrice?: string,
  status = "OPEN",
) {
  const { rows } = await pool.query(
    `INSERT INTO orders (user_id, pair_id, side, type, qty, qty_filled, limit_price, status)
     VALUES ($1, $2, $3, $4, $5, '0.00000000', $6, $7)
     RETURNING *`,
    [userId, pairId, side, type, qty, limitPrice ?? null, status],
  );
  return rows[0];
}

/* ── Risk limits (widen so tests aren't blocked) ──────── */

export async function seedRiskLimits(pool: Pool) {
  await pool.query(`
    INSERT INTO risk_limits
      (user_id, pair_id, max_order_notional_quote, max_position_base_qty,
       max_open_orders_per_pair, max_price_deviation_bps)
    VALUES
      (NULL, NULL, '999999999.00000000', '999999999.00000000', 9999, 99999)
    ON CONFLICT ((COALESCE(user_id, '00000000-0000-0000-0000-000000000000'::uuid)),
                 (COALESCE(pair_id, '00000000-0000-0000-0000-000000000000'::uuid)))
    DO UPDATE SET
      max_order_notional_quote = EXCLUDED.max_order_notional_quote,
      max_position_base_qty    = EXCLUDED.max_position_base_qty,
      max_open_orders_per_pair = EXCLUDED.max_open_orders_per_pair,
      max_price_deviation_bps  = EXCLUDED.max_price_deviation_bps
  `);
}
