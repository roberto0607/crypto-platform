import "dotenv/config";
import { pool } from "../db/pool";
import { hashPassword } from "../auth/password";

/*
 * Deterministic seed script for dev/demo environments.
 *
 * Creates:
 *   - Admin + demo users (upsert by email_normalized)
 *   - BTC, USD, ETH, SOL assets (upsert by symbol)
 *   - BTC/USD, ETH/USD, SOL/USD trading pairs (upsert by symbol)
 *   - Wallets with fixed balances
 *
 * Historical candles are backfilled separately via `pnpm backfill`.
 *
 * Idempotent — safe to re-run.
 * All data is fixed (no Math.random).
 */

const ADMIN_EMAIL = "admin@demo.local";
const DEMO_EMAIL = "demo@demo.local";
const ADMIN_PASS = "Admin123!";
const DEMO_PASS = "Demo123!";

const SEED_BALANCES = {
  admin: { BTC: "10.00000000", USD: "500000.00000000", ETH: "50.00000000", SOL: "500.00000000" },
  demo: { BTC: "1.00000000", USD: "100000.00000000", ETH: "5.00000000", SOL: "50.00000000" },
} as const;

async function seed(): Promise<void> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    console.log("Seeding dev data...");

    // ── Users ──
    const adminHash = await hashPassword(ADMIN_PASS);
    const demoHash = await hashPassword(DEMO_PASS);

    const adminResult = await client.query<{ id: string }>(
      `INSERT INTO users (id, email, email_normalized, password_hash, role)
       VALUES (gen_random_uuid(), $1, $2, $3, 'admin')
       ON CONFLICT (email_normalized) DO UPDATE
         SET password_hash = EXCLUDED.password_hash,
             role = EXCLUDED.role
       RETURNING id`,
      [ADMIN_EMAIL, ADMIN_EMAIL.toLowerCase(), adminHash]
    );
    const adminId = adminResult.rows[0].id;
    console.log(`  Admin user: ${adminId}`);

    const demoResult = await client.query<{ id: string }>(
      `INSERT INTO users (id, email, email_normalized, password_hash, role)
       VALUES (gen_random_uuid(), $1, $2, $3, 'user')
       ON CONFLICT (email_normalized) DO UPDATE
         SET password_hash = EXCLUDED.password_hash,
             role = EXCLUDED.role
       RETURNING id`,
      [DEMO_EMAIL, DEMO_EMAIL.toLowerCase(), demoHash]
    );
    const demoId = demoResult.rows[0].id;
    console.log(`  Demo user:  ${demoId}`);

    // ── Assets ──
    const btcResult = await client.query<{ id: string }>(
      `INSERT INTO assets (id, symbol, name, decimals)
       VALUES (gen_random_uuid(), 'BTC', 'Bitcoin', 8)
       ON CONFLICT (symbol) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`
    );
    const btcId = btcResult.rows[0].id;

    const usdResult = await client.query<{ id: string }>(
      `INSERT INTO assets (id, symbol, name, decimals)
       VALUES (gen_random_uuid(), 'USD', 'US Dollar', 2)
       ON CONFLICT (symbol) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`
    );
    const usdId = usdResult.rows[0].id;

    const ethResult = await client.query<{ id: string }>(
      `INSERT INTO assets (id, symbol, name, decimals)
       VALUES (gen_random_uuid(), 'ETH', 'Ethereum', 8)
       ON CONFLICT (symbol) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`
    );
    const ethId = ethResult.rows[0].id;

    const solResult = await client.query<{ id: string }>(
      `INSERT INTO assets (id, symbol, name, decimals)
       VALUES (gen_random_uuid(), 'SOL', 'Solana', 8)
       ON CONFLICT (symbol) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`
    );
    const solId = solResult.rows[0].id;
    console.log(`  Assets: BTC=${btcId}, USD=${usdId}, ETH=${ethId}, SOL=${solId}`);

    // ── Trading Pair ──
    const pairResult = await client.query<{ id: string }>(
      `INSERT INTO trading_pairs (id, base_asset_id, quote_asset_id, symbol, fee_bps, maker_fee_bps, taker_fee_bps)
       VALUES (gen_random_uuid(), $1, $2, 'BTC/USD', 10, 2, 5)
       ON CONFLICT (symbol) DO UPDATE
         SET fee_bps = EXCLUDED.fee_bps,
             maker_fee_bps = EXCLUDED.maker_fee_bps,
             taker_fee_bps = EXCLUDED.taker_fee_bps
       RETURNING id`,
      [btcId, usdId]
    );
    const pairId = pairResult.rows[0].id;

    await client.query(
      `INSERT INTO trading_pairs (id, base_asset_id, quote_asset_id, symbol, fee_bps, maker_fee_bps, taker_fee_bps)
       VALUES (gen_random_uuid(), $1, $2, 'ETH/USD', 10, 2, 5)
       ON CONFLICT (symbol) DO UPDATE
         SET fee_bps = EXCLUDED.fee_bps,
             maker_fee_bps = EXCLUDED.maker_fee_bps,
             taker_fee_bps = EXCLUDED.taker_fee_bps`,
      [ethId, usdId]
    );

    await client.query(
      `INSERT INTO trading_pairs (id, base_asset_id, quote_asset_id, symbol, fee_bps, maker_fee_bps, taker_fee_bps)
       VALUES (gen_random_uuid(), $1, $2, 'SOL/USD', 10, 2, 5)
       ON CONFLICT (symbol) DO UPDATE
         SET fee_bps = EXCLUDED.fee_bps,
             maker_fee_bps = EXCLUDED.maker_fee_bps,
             taker_fee_bps = EXCLUDED.taker_fee_bps`,
      [solId, usdId]
    );

    console.log(`  Pairs: BTC/USD=${pairId}, ETH/USD, SOL/USD`);

    // ── Wallets (upsert with fixed balances) ──
    for (const [label, userId, balances] of [
      ["admin", adminId, SEED_BALANCES.admin],
      ["demo", demoId, SEED_BALANCES.demo],
    ] as const) {
      for (const [symbol, assetId, balance] of [
        ["BTC", btcId, balances.BTC],
        ["USD", usdId, balances.USD],
        ["ETH", ethId, balances.ETH],
        ["SOL", solId, balances.SOL],
      ] as const) {
        await client.query(
          `INSERT INTO wallets (id, user_id, asset_id, balance, reserved)
           VALUES (gen_random_uuid(), $1, $2, $3, '0.00000000')
           ON CONFLICT (user_id, asset_id,
                        COALESCE(competition_id, '00000000-0000-0000-0000-000000000000'::uuid),
                        COALESCE(match_id, '00000000-0000-0000-0000-000000000000'::uuid))
           DO UPDATE
             SET balance = EXCLUDED.balance,
                 reserved = '0.00000000'`,
          [userId, assetId, balance]
        );
      }
      console.log(`  Wallets seeded for ${label}`);
    }

    // Note: historical candles are now backfilled from Kraken REST API
    // via `pnpm backfill`. No deterministic candle data needed here.

    await client.query("COMMIT");
    console.log("\nSeed complete.");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Seed failed, rolled back:", err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

seed();
