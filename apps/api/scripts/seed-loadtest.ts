import 'dotenv/config';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { pool } from '../src/db/pool';
import { hashPassword } from '../src/auth/password';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ADMIN_EMAIL = 'admin@demo.local';
const ADMIN_PASS = 'Admin123!';
const LOADTEST_PASS = 'Loadtest123!';

const USER_COUNT = parseInt(process.env.LOADTEST_USERS ?? '50', 10);
const USD_BALANCE = process.env.LOADTEST_USD_BALANCE ?? '100000.00000000';

// Manifest is written next to the k6 scripts so open() can resolve it
const MANIFEST_PATH = resolve(__dirname, '../load/k6/seed-manifest.json');

async function seedLoadtest(): Promise<void> {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    console.log(`Seeding load test data: ${USER_COUNT} users, $${USD_BALANCE} USD each...`);

    // ── Admin user (ensure exists) ──
    const adminHash = await hashPassword(ADMIN_PASS);
    await client.query(
      `INSERT INTO users (id, email, email_normalized, password_hash, role)
       VALUES (gen_random_uuid(), $1, $2, $3, 'ADMIN')
       ON CONFLICT (email_normalized) DO UPDATE
         SET password_hash = EXCLUDED.password_hash,
             role = EXCLUDED.role`,
      [ADMIN_EMAIL, ADMIN_EMAIL.toLowerCase(), adminHash]
    );

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

    // ── Trading pair ──
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

    // Ensure last_price is set so MARKET orders have a reference price
    await client.query(
      `UPDATE trading_pairs
       SET last_price = '43650.00000000'
       WHERE id = $1
         AND (last_price IS NULL OR last_price = '0' OR last_price = '0.00000000')`,
      [pairId]
    );

    // ── Load test users ──
    const users: Array<{ email: string; password: string }> = [];

    for (let i = 0; i < USER_COUNT; i++) {
      const email = `loadtest_user_${i}@loadtest.local`;
      const emailNormalized = email.toLowerCase();
      const passwordHash = await hashPassword(LOADTEST_PASS);

      const userResult = await client.query<{ id: string }>(
        `INSERT INTO users (id, email, email_normalized, password_hash, role)
         VALUES (gen_random_uuid(), $1, $2, $3, 'USER')
         ON CONFLICT (email_normalized) DO UPDATE
           SET password_hash = EXCLUDED.password_hash
         RETURNING id`,
        [email, emailNormalized, passwordHash]
      );
      const userId = userResult.rows[0].id;

      // USD wallet — credit starting balance
      await client.query(
        `INSERT INTO wallets (id, user_id, asset_id, balance, reserved)
         VALUES (gen_random_uuid(), $1, $2, $3, '0.00000000')
         ON CONFLICT (user_id, asset_id, COALESCE(competition_id, '00000000-0000-0000-0000-000000000000'::uuid), COALESCE(match_id, '00000000-0000-0000-0000-000000000000'::uuid))
         DO UPDATE
           SET balance = EXCLUDED.balance,
               reserved = '0.00000000'`,
        [userId, usdId, USD_BALANCE]
      );

      // BTC wallet — zero balance (users will buy BTC during tests)
      await client.query(
        `INSERT INTO wallets (id, user_id, asset_id, balance, reserved)
         VALUES (gen_random_uuid(), $1, $2, '0.00000000', '0.00000000')
         ON CONFLICT (user_id, asset_id, COALESCE(competition_id, '00000000-0000-0000-0000-000000000000'::uuid), COALESCE(match_id, '00000000-0000-0000-0000-000000000000'::uuid))
         DO NOTHING`,
        [userId, btcId]
      );

      users.push({ email, password: LOADTEST_PASS });

      if ((i + 1) % 10 === 0) {
        console.log(`  Created ${i + 1}/${USER_COUNT} users...`);
      }
    }

    // ── Risk/governance reset removed ──
    // The pre-migration-059 seed reset circuit_breakers, account_limits, and
    // incidents here so the governance gate would pass for loadtest users.
    // Migration 059_drop_exchange_tables.sql (2026-05-18) dropped all three
    // tables ("exchange-complexity ... unnecessary for paper trading"), so
    // there is nothing to reset. Order placement no longer gates on them.

    await client.query('COMMIT');

    console.log(`\nLoad test seed complete.`);
    console.log(`  Users created: ${USER_COUNT}`);
    console.log(`  Pair ID: ${pairId}`);

    // ── Write seed manifest for k6 scripts ──
    const manifest = { pairId, users };
    mkdirSync(resolve(__dirname, '../load/k6'), { recursive: true });
    writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
    console.log(`  Manifest written: ${MANIFEST_PATH}`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Load test seed failed, rolled back:', err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

seedLoadtest();
