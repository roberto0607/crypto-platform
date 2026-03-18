/**
 * Idempotent dev-environment seed script.
 *
 * Restores the full dev environment after test runs:
 * 1. Creates/updates the dev account (rtirado0607@gmail.com)
 * 2. Ensures wallets for all active assets, USD balance = $100k
 * 3. Deactivates junk test pairs (keeps BTC/USD, ETH/USD, SOL/USD)
 * 4. Backfills candles from Kraken if BTC/USD has < 100 candles
 * 5. Syncs live prices from Kraken REST into trading_pairs.last_price
 *
 * Safe to run multiple times — uses ON CONFLICT DO NOTHING / DO UPDATE.
 *
 * Usage:
 *   cd apps/api && pnpm dev:me
 */
import "dotenv/config";
import { execSync } from "node:child_process";
import { pool } from "../src/db/pool";
import { hashPassword } from "../src/auth/password";

const EMAIL = "rtirado0607@gmail.com";
const PASSWORD = "Likemike23ts$";
const DISPLAY_NAME = "rtirado0607";
const USD_BALANCE = "100000.00000000";
const REAL_PAIRS = ["BTC/USD", "ETH/USD", "SOL/USD"];
const MIN_CANDLES = 100;

async function main() {
    console.log("=== Dev Environment Seed ===\n");

    // 1. Ensure user exists
    const hash = await hashPassword(PASSWORD);

    const userResult = await pool.query<{ id: string }>(
        `INSERT INTO users (email, email_normalized, password_hash, display_name)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (email_normalized) DO UPDATE
           SET display_name = EXCLUDED.display_name
         RETURNING id`,
        [EMAIL, EMAIL.toLowerCase(), hash, DISPLAY_NAME],
    );
    const userId = userResult.rows[0]!.id;
    console.log(`User: ${EMAIL} (${userId})`);

    // 2. Ensure wallets for all active assets
    const walletResult = await pool.query(
        `INSERT INTO wallets (id, user_id, asset_id, balance, reserved)
         SELECT gen_random_uuid(), $1, a.id, '0.00000000', '0.00000000'
         FROM assets a
         ON CONFLICT DO NOTHING`,
        [userId],
    );
    console.log(`Wallets created: ${walletResult.rowCount ?? 0}`);

    // 3. Set USD balance to $100k
    const usdResult = await pool.query(
        `UPDATE wallets SET balance = $1
         WHERE user_id = $2
           AND asset_id = (SELECT id FROM assets WHERE symbol = 'USD' LIMIT 1)`,
        [USD_BALANCE, userId],
    );
    console.log(`USD balance: ${usdResult.rowCount ? "$100,000" : "no USD asset found"}`);

    // 4. Ensure user tier
    await pool.query(
        `INSERT INTO user_tiers (user_id, tier, updated_at)
         VALUES ($1, 'ROOKIE', now())
         ON CONFLICT (user_id) DO NOTHING`,
        [userId],
    );
    console.log("Tier: ROOKIE (preserved if already set)");

    // 5. Deactivate junk test pairs
    const deactivated = await pool.query(
        `UPDATE trading_pairs SET is_active = false
         WHERE is_active = true AND symbol <> ALL($1::text[])`,
        [REAL_PAIRS],
    );
    if ((deactivated.rowCount ?? 0) > 0) {
        console.log(`Test pairs deactivated: ${deactivated.rowCount}`);
    }

    // 6. Backfill candles if needed
    const btcPair = await pool.query<{ id: string }>(
        `SELECT id FROM trading_pairs WHERE symbol = 'BTC/USD' LIMIT 1`,
    );
    if (btcPair.rows.length > 0) {
        const candleCount = await pool.query<{ count: string }>(
            `SELECT COUNT(*)::text AS count FROM candles WHERE pair_id = $1`,
            [btcPair.rows[0]!.id],
        );
        const count = parseInt(candleCount.rows[0]!.count, 10);
        if (count < MIN_CANDLES) {
            console.log(`\nCandles for BTC/USD: ${count} (< ${MIN_CANDLES}) — running backfill...`);
            try {
                execSync("pnpm backfill", { stdio: "inherit", cwd: process.cwd() });
            } catch {
                console.error("Candle backfill failed — run 'pnpm backfill' manually");
            }
        } else {
            console.log(`Candles for BTC/USD: ${count} (sufficient)`);
        }
    }

    // 7. Sync live prices from Kraken into trading_pairs.last_price
    await syncLivePrices();

    console.log("\n=== Done ===");
}

const KRAKEN_TICKER_URL = "https://api.kraken.com/0/public/Ticker?pair=XBTUSD,ETHUSD,SOLUSD";
const KRAKEN_TO_SYMBOL: Record<string, string> = {
    XXBTZUSD: "BTC/USD",
    XETHZUSD: "ETH/USD",
    SOLUSD: "SOL/USD",
};

async function syncLivePrices(): Promise<void> {
    try {
        const res = await fetch(KRAKEN_TICKER_URL);
        const json = await res.json() as { error: string[]; result: Record<string, { c: [string, string] }> };
        if (json.error?.length > 0) {
            console.error("Kraken ticker error:", json.error);
            return;
        }
        let updated = 0;
        for (const [krakenPair, data] of Object.entries(json.result)) {
            const symbol = KRAKEN_TO_SYMBOL[krakenPair];
            if (!symbol) continue;
            const price = data.c[0]; // c = [price, lot_volume] (last trade closed)
            const result = await pool.query(
                `UPDATE trading_pairs SET last_price = $1 WHERE symbol = $2`,
                [price, symbol],
            );
            if ((result.rowCount ?? 0) > 0) {
                console.log(`Price ${symbol}: $${parseFloat(price).toLocaleString()}`);
                updated++;
            }
        }
        if (updated === 0) {
            console.log("Prices: no matching pairs to update");
        }
    } catch (err) {
        console.error("Price sync failed:", (err as Error).message);
    }
}

main()
    .catch((err) => {
        console.error("Seed failed:", err);
        process.exitCode = 1;
    })
    .finally(() => pool.end());
