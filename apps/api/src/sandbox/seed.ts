import "dotenv/config";
import { pool } from "../db/pool";
import { hashPassword } from "../auth/password";

/*
 * Deterministic seed script for dev/demo environments.
 *
 * Creates:
 *   - Admin + demo users (upsert by email_normalized)
 *   - BTC + USD assets (upsert by symbol)
 *   - BTC/USD trading pair (upsert by symbol)
 *   - Wallets with fixed balances
 *   - 24 hours of deterministic 1h candles
 *
 * Idempotent — safe to re-run.
 * All data is fixed (no Math.random).
 */

const ADMIN_EMAIL = "admin@demo.local";
const DEMO_EMAIL = "demo@demo.local";
const ADMIN_PASS = "Admin123!";
const DEMO_PASS = "Demo123!";

const SEED_BALANCES = {
  admin: { BTC: "10.00000000", USD: "500000.00000000" },
  demo: { BTC: "1.00000000", USD: "100000.00000000" },
} as const;

// Deterministic 1h candles: 24 entries starting 2025-01-01T00:00:00Z
const CANDLE_START = "2025-01-01T00:00:00Z";
const CANDLE_DATA: Array<[number, string, string, string, string, string]> = [
  // [hourOffset, open, high, low, close, volume]
  [0,  "42000.00", "42350.00", "41800.00", "42200.00", "12.50000000"],
  [1,  "42200.00", "42500.00", "42100.00", "42400.00", "10.20000000"],
  [2,  "42400.00", "42600.00", "42300.00", "42550.00", "8.30000000"],
  [3,  "42550.00", "42700.00", "42400.00", "42650.00", "9.10000000"],
  [4,  "42650.00", "42800.00", "42500.00", "42750.00", "11.00000000"],
  [5,  "42750.00", "42900.00", "42600.00", "42850.00", "7.80000000"],
  [6,  "42850.00", "43000.00", "42700.00", "42950.00", "6.50000000"],
  [7,  "42950.00", "43100.00", "42800.00", "43050.00", "8.90000000"],
  [8,  "43050.00", "43200.00", "42900.00", "43150.00", "13.20000000"],
  [9,  "43150.00", "43400.00", "43000.00", "43350.00", "15.00000000"],
  [10, "43350.00", "43500.00", "43200.00", "43450.00", "14.10000000"],
  [11, "43450.00", "43600.00", "43300.00", "43500.00", "11.70000000"],
  [12, "43500.00", "43650.00", "43350.00", "43400.00", "10.40000000"],
  [13, "43400.00", "43500.00", "43200.00", "43250.00", "9.60000000"],
  [14, "43250.00", "43400.00", "43100.00", "43300.00", "8.80000000"],
  [15, "43300.00", "43450.00", "43150.00", "43200.00", "7.50000000"],
  [16, "43200.00", "43350.00", "43050.00", "43100.00", "6.90000000"],
  [17, "43100.00", "43250.00", "42950.00", "43050.00", "8.20000000"],
  [18, "43050.00", "43200.00", "42900.00", "43150.00", "10.00000000"],
  [19, "43150.00", "43350.00", "43050.00", "43300.00", "12.30000000"],
  [20, "43300.00", "43500.00", "43200.00", "43450.00", "14.50000000"],
  [21, "43450.00", "43600.00", "43350.00", "43550.00", "11.80000000"],
  [22, "43550.00", "43700.00", "43400.00", "43600.00", "9.40000000"],
  [23, "43600.00", "43750.00", "43500.00", "43650.00", "10.10000000"],
];

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
    console.log(`  Assets: BTC=${btcId}, USD=${usdId}`);

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
    console.log(`  Pair: BTC/USD=${pairId}`);

    // ── Wallets (upsert with fixed balances) ──
    for (const [label, userId, balances] of [
      ["admin", adminId, SEED_BALANCES.admin],
      ["demo", demoId, SEED_BALANCES.demo],
    ] as const) {
      for (const [symbol, assetId, balance] of [
        ["BTC", btcId, balances.BTC],
        ["USD", usdId, balances.USD],
      ] as const) {
        await client.query(
          `INSERT INTO wallets (id, user_id, asset_id, balance, reserved)
           VALUES (gen_random_uuid(), $1, $2, $3, '0.00000000')
           ON CONFLICT (user_id, asset_id) DO UPDATE
             SET balance = EXCLUDED.balance,
                 reserved = '0.00000000'`,
          [userId, assetId, balance]
        );
      }
      console.log(`  Wallets seeded for ${label}`);
    }

    // ── Candles (deterministic 1h set) ──
    const startMs = new Date(CANDLE_START).getTime();

    for (const [hourOffset, open, high, low, close, volume] of CANDLE_DATA) {
      const ts = new Date(startMs + hourOffset * 3600_000).toISOString();
      await client.query(
        `INSERT INTO candles (pair_id, timeframe, ts, open, high, low, close, volume)
         VALUES ($1, '1h', $2, $3, $4, $5, $6, $7)
         ON CONFLICT (pair_id, timeframe, ts) DO UPDATE
           SET open = EXCLUDED.open,
               high = EXCLUDED.high,
               low  = EXCLUDED.low,
               close = EXCLUDED.close,
               volume = EXCLUDED.volume`,
        [pairId, ts, open, high, low, close, volume]
      );
    }
    console.log(`  Candles: ${CANDLE_DATA.length} x 1h entries`);

    // ── Update pair last_price to latest candle close ──
    const lastClose = CANDLE_DATA[CANDLE_DATA.length - 1][4];
    await client.query(
      `UPDATE trading_pairs SET last_price = $1 WHERE id = $2`,
      [lastClose, pairId]
    );

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
