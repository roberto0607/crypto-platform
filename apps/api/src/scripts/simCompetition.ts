/**
 * Simulation script — populates a weekly competition with fake users and trades.
 *
 * Usage:
 *   cd apps/api && npx tsx src/scripts/simCompetition.ts
 *
 * What it does:
 *   1. Creates 25 fake users
 *   2. Joins them to the ROOKIE W10 competition
 *   3. Seeds each user with some BTC/ETH/SOL so they can sell
 *   4. Each user places 5-8 random trades (paired BUY+SELL LIMIT orders that match)
 *   5. Refreshes leaderboard rankings
 *   6. Finalizes the competition (status → ENDED)
 *   7. Runs tier adjustments (promote top 20%, demote bottom 20%, badge #1)
 *   8. Prints results
 */

import { pool } from "../db/pool.js";
import { joinCompetition, refreshLeaderboard, finalizeCompetition } from "../competitions/competitionService.js";
import { placeOrderWithSnapshot } from "../trading/phase6OrderService.js";
import { weeklyCompetitionJob } from "../jobs/definitions/weeklyCompetitionJob.js";
import { getLeaderboard } from "../competitions/leaderboardRepo.js";
import crypto from "node:crypto";
import argon2 from "argon2";

// ── Config ──
const NUM_USERS = 25;
const MIN_TRADES = 5;
const MAX_TRADES = 8;
const TIER = "ROOKIE";
const WEEK_ID = "2026-W10";

const logger = {
    info: (...args: any[]) => console.log("[INFO]", JSON.stringify(args[0]), args[1] ?? ""),
    error: (...args: any[]) => console.error("[ERROR]", JSON.stringify(args[0]), args[1] ?? ""),
    warn: (...args: any[]) => console.warn("[WARN]", JSON.stringify(args[0]), args[1] ?? ""),
};

function rand(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randDecimal(min: number, max: number, decimals = 4): string {
    return (Math.random() * (max - min) + min).toFixed(decimals);
}

async function main() {
    try {
        // ── Step 0: Find competition ──
        console.log("\n=== STEP 0: Find ROOKIE W10 competition ===");
        const { rows: compRows } = await pool.query<{ id: string; name: string; status: string }>(
            `SELECT id, name, status FROM competitions
             WHERE competition_type = 'WEEKLY' AND tier = $1 AND week_id = $2`,
            [TIER, WEEK_ID],
        );

        if (compRows.length === 0) {
            console.error(`No ROOKIE W10 competition found. Run triggerWeekly.ts first.`);
            process.exit(1);
        }

        const comp = compRows[0];
        console.log(`  Competition: ${comp.name} (${comp.id})`);
        console.log(`  Status: ${comp.status}`);

        // ── Step 0a: Reset competition to ACTIVE + clean previous sim data ──
        await pool.query(`UPDATE competitions SET status = 'ACTIVE', tier_adjustments_processed = false WHERE id = $1`, [comp.id]);
        // Delete previous sim data (order matters due to FK constraints)
        await pool.query(`DELETE FROM competition_leaderboard WHERE competition_id = $1`, [comp.id]);
        await pool.query(`DELETE FROM user_tier_history WHERE competition_id = $1`, [comp.id]);
        await pool.query(`DELETE FROM user_badges WHERE competition_id = $1`, [comp.id]);
        // closed_trades are competition-scoped
        await pool.query(`DELETE FROM closed_trades WHERE competition_id = $1`, [comp.id]);
        await pool.query(
            `DELETE FROM trades WHERE buy_order_id IN (SELECT id FROM orders WHERE competition_id = $1)
             OR sell_order_id IN (SELECT id FROM orders WHERE competition_id = $1)`,
            [comp.id],
        );
        await pool.query(`DELETE FROM orders WHERE competition_id = $1`, [comp.id]);
        await pool.query(`DELETE FROM positions WHERE competition_id = $1`, [comp.id]);
        // ledger_entries + equity_snapshots reference wallets or are competition-scoped
        await pool.query(
            `DELETE FROM ledger_entries WHERE wallet_id IN (SELECT id FROM wallets WHERE competition_id = $1)`,
            [comp.id],
        );
        await pool.query(`DELETE FROM equity_snapshots WHERE competition_id = $1`, [comp.id]);
        await pool.query(`DELETE FROM wallets WHERE competition_id = $1`, [comp.id]);
        await pool.query(`DELETE FROM competition_participants WHERE competition_id = $1`, [comp.id]);
        console.log("  Reset competition state (cleaned previous sim data)");

        // ── Step 0b: Clear circuit breakers ──
        await pool.query(`UPDATE circuit_breakers SET status = 'CLOSED' WHERE status = 'OPEN'`);
        console.log("  Circuit breakers cleared");

        // ── Step 1: Lookup trading pairs + asset IDs ──
        console.log("\n=== STEP 1: Lookup trading pairs and assets ===");

        // Force-set last_price to known reference prices (needed for fallback snapshot)
        const refPrices: Record<string, string> = {
            "BTC/USD": "65000.00",
            "ETH/USD": "3500.00",
            "SOL/USD": "150.00",
        };
        for (const [sym, price] of Object.entries(refPrices)) {
            await pool.query(
                `UPDATE trading_pairs SET last_price = $1 WHERE symbol = $2`,
                [price, sym],
            );
        }

        const { rows: pairRows } = await pool.query<{ id: string; symbol: string; base_asset_id: string }>(
            `SELECT id, symbol, base_asset_id FROM trading_pairs
             WHERE symbol IN ('BTC/USD', 'ETH/USD', 'SOL/USD') AND is_active = true`,
        );
        if (pairRows.length === 0) {
            console.error("No trading pairs found!");
            process.exit(1);
        }
        const pairs = pairRows.map((p) => ({ id: p.id, symbol: p.symbol, baseAssetId: p.base_asset_id }));
        console.log(`  Pairs: ${pairs.map((p) => p.symbol).join(", ")}`);

        // ── Step 2: Create fake users ──
        console.log(`\n=== STEP 2: Create ${NUM_USERS} fake users ===`);
        const passwordHash = await argon2.hash("SimPass123!");
        const userIds: string[] = [];

        for (let i = 1; i <= NUM_USERS; i++) {
            const email = `simuser${i}@test.local`;
            const displayName = `Trader_${String(i).padStart(2, "0")}`;
            const { rows } = await pool.query<{ id: string }>(
                `INSERT INTO users (id, email, email_normalized, password_hash, display_name, role)
                 VALUES (gen_random_uuid(), $1, $1, $2, $3, 'USER')
                 ON CONFLICT (email_normalized) DO UPDATE SET display_name = EXCLUDED.display_name
                 RETURNING id`,
                [email, passwordHash, displayName],
            );
            userIds.push(rows[0].id);
        }
        console.log(`  Created/upserted ${userIds.length} users`);

        // ── Step 3: Join all users to competition ──
        console.log(`\n=== STEP 3: Join users to competition ===`);
        let joined = 0;
        for (const userId of userIds) {
            try {
                await joinCompetition(userId, comp.id);
                joined++;
            } catch (err: any) {
                if (err.message === "already_joined") {
                    joined++; // already in, that's fine
                } else {
                    console.error(`  Failed to join user ${userId}: ${err.message}`);
                }
            }
        }
        console.log(`  ${joined}/${userIds.length} users joined`);

        // ── Step 3b: Seed base asset balances for sellers ──
        // Users start with $100K USD only. To allow sells, we credit
        // small amounts of BTC/ETH/SOL directly into their competition wallets.
        console.log(`\n=== STEP 3b: Seed base asset balances ===`);
        const seedAmounts: Record<string, string> = {
            "BTC/USD": "2.00000000",   // ~$130K worth at $65K
            "ETH/USD": "30.00000000",  // ~$105K worth at $3.5K
            "SOL/USD": "500.00000000", // ~$75K worth at $150
        };

        for (const userId of userIds) {
            for (const pair of pairs) {
                const amount = seedAmounts[pair.symbol];
                await pool.query(
                    `UPDATE wallets SET balance = balance + $1::numeric
                     WHERE user_id = $2 AND asset_id = $3 AND competition_id = $4`,
                    [amount, userId, pair.baseAssetId, comp.id],
                );
            }
        }
        console.log(`  Seeded BTC/ETH/SOL balances for ${userIds.length} users`);

        // ── Step 4: Place random trades ──
        console.log(`\n=== STEP 4: Place random trades ===`);

        // Approximate prices for each pair
        const pairPrices: Record<string, number> = {
            "BTC/USD": 65000,
            "ETH/USD": 3500,
            "SOL/USD": 150,
        };

        const pairQty: Record<string, { min: number; max: number }> = {
            "BTC/USD": { min: 0.001, max: 0.02 },
            "ETH/USD": { min: 0.01, max: 0.3 },
            "SOL/USD": { min: 0.5, max: 5 },
        };

        let totalTrades = 0;
        const tradesPerUser = new Map<string, number>();
        userIds.forEach((u) => tradesPerUser.set(u, 0));

        // For each user, generate a target trade count
        const targetTrades = new Map<string, number>();
        for (const userId of userIds) {
            targetTrades.set(userId, rand(MIN_TRADES, MAX_TRADES));
        }

        // Strategy: pair users up. One places a SELL LIMIT, other places BUY LIMIT
        // at the same price, so they match immediately. Both get a fill (trade).
        const maxRounds = MAX_TRADES;
        for (let round = 0; round < maxRounds; round++) {
            // Users who still need trades
            const needsTrades = userIds.filter(
                (u) => (tradesPerUser.get(u) ?? 0) < (targetTrades.get(u) ?? 0),
            );

            if (needsTrades.length < 2) break;

            // Shuffle
            for (let i = needsTrades.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [needsTrades[i], needsTrades[j]] = [needsTrades[j], needsTrades[i]];
            }

            const pairCount = Math.floor(needsTrades.length / 2);
            let roundTrades = 0;

            for (let i = 0; i < pairCount; i++) {
                const seller = needsTrades[i * 2];
                const buyer = needsTrades[i * 2 + 1];

                // Pick a random trading pair
                const pair = pairs[Math.floor(Math.random() * pairs.length)];
                const basePrice = pairPrices[pair.symbol] ?? 1000;

                // Vary price ±2% to stay within risk limits (500 bps max deviation)
                const priceVariance = 0.98 + Math.random() * 0.04;
                const price = (basePrice * priceVariance).toFixed(2);
                const qtyRange = pairQty[pair.symbol] ?? { min: 0.01, max: 0.1 };
                const qty = randDecimal(qtyRange.min, qtyRange.max, 6);

                try {
                    // Seller places LIMIT sell first (resting order)
                    await placeOrderWithSnapshot(
                        seller,
                        { pairId: pair.id, side: "SELL", type: "LIMIT", qty, limitPrice: price },
                        crypto.randomUUID(),
                        `sim-r${round}-s${i}`,
                        comp.id,
                    );

                    // Buyer places LIMIT buy at same price → immediate match
                    await placeOrderWithSnapshot(
                        buyer,
                        { pairId: pair.id, side: "BUY", type: "LIMIT", qty, limitPrice: price },
                        crypto.randomUUID(),
                        `sim-r${round}-b${i}`,
                        comp.id,
                    );

                    tradesPerUser.set(buyer, (tradesPerUser.get(buyer) ?? 0) + 1);
                    tradesPerUser.set(seller, (tradesPerUser.get(seller) ?? 0) + 1);
                    totalTrades += 2;
                    roundTrades += 2;
                } catch (err: any) {
                    // Insufficient balance or other errors — skip silently
                    const msg = err.message ?? String(err);
                    if (!msg.includes("insufficient")) {
                        console.log(`    Round ${round + 1}, match ${i}: ${msg}`);
                    }
                }
            }

            console.log(`  Round ${round + 1}/${maxRounds}: +${roundTrades} trades (${totalTrades} total)`);
        }

        console.log(`  Total trade-fills: ${totalTrades}`);

        // Show trade distribution
        const tradeCounts = Array.from(tradesPerUser.values());
        const qualified = tradeCounts.filter((t) => t >= MIN_TRADES).length;
        console.log(`  Qualified (>= ${MIN_TRADES} trades): ${qualified}/${userIds.length}`);
        console.log(`  Trade distribution: min=${Math.min(...tradeCounts)}, max=${Math.max(...tradeCounts)}, avg=${(tradeCounts.reduce((a, b) => a + b, 0) / tradeCounts.length).toFixed(1)}`);

        // ── Step 5: Refresh leaderboard ──
        console.log(`\n=== STEP 5: Refresh leaderboard ===`);
        await refreshLeaderboard(comp.id);
        console.log("  Leaderboard refreshed");

        // ── Step 6: Finalize competition ──
        console.log(`\n=== STEP 6: Finalize competition (status → ENDED) ===`);
        await finalizeCompetition(comp.id);
        console.log("  Competition finalized");

        // ── Step 7: Run tier adjustments ──
        console.log(`\n=== STEP 7: Process tier adjustments ===`);
        await weeklyCompetitionJob.run({ logger } as any);
        console.log("  Tier adjustments processed");

        // ── Step 8: Print results ──
        console.log(`\n\n${"=".repeat(70)}`);
        console.log("  FINAL RESULTS");
        console.log(`${"=".repeat(70)}\n`);

        // Leaderboard
        const leaderboard = await getLeaderboard(comp.id);
        console.log("Rank | Display Name        | Return %  | Equity       | Trades | Qualified | Tier Change");
        console.log("-----|---------------------|-----------|--------------|--------|-----------|------------");

        for (const entry of leaderboard) {
            const returnPct = parseFloat(entry.return_pct).toFixed(2);
            const equity = parseFloat(entry.equity).toFixed(2);
            const qualifiedStr = entry.qualified ? "YES" : "NO";

            // Check tier history for this user
            const { rows: tierHistory } = await pool.query<{ old_tier: string; new_tier: string; reason: string }>(
                `SELECT old_tier, new_tier, reason FROM user_tier_history
                 WHERE user_id = $1 AND competition_id = $2
                 ORDER BY created_at DESC LIMIT 1`,
                [entry.user_id, comp.id],
            );
            const tierChange = tierHistory.length > 0
                ? `${tierHistory[0].old_tier} → ${tierHistory[0].new_tier}`
                : "-";

            console.log(
                `${String(entry.rank).padStart(4)} | ${(entry.display_name ?? "unknown").padEnd(19)} | ${returnPct.padStart(8)}% | $${equity.padStart(11)} | ${String(entry.trades_count).padStart(6)} | ${qualifiedStr.padStart(9)} | ${tierChange}`,
            );
        }

        // Champion badge
        const { rows: champions } = await pool.query<{ display_name: string; tier: string; week_id: string }>(
            `SELECT u.display_name, ub.tier, ub.week_id
             FROM user_badges ub
             JOIN users u ON u.id = ub.user_id
             WHERE ub.competition_id = $1 AND ub.badge_type = 'WEEKLY_CHAMPION'`,
            [comp.id],
        );
        if (champions.length > 0) {
            console.log(`\nWeekly Champion: ${champions[0].display_name} (${champions[0].tier} tier, ${champions[0].week_id})`);
        }

        // Tier summary
        const { rows: tierSummary } = await pool.query<{ new_tier: string; reason: string; cnt: string }>(
            `SELECT new_tier, reason, COUNT(*)::text AS cnt
             FROM user_tier_history WHERE competition_id = $1
             GROUP BY new_tier, reason ORDER BY reason, new_tier`,
            [comp.id],
        );
        if (tierSummary.length > 0) {
            console.log(`\nTier Adjustments:`);
            for (const row of tierSummary) {
                console.log(`  ${row.reason}: ${row.cnt} user(s) → ${row.new_tier}`);
            }
        }

        console.log(`\n${"=".repeat(70)}\n`);
    } catch (err) {
        console.error("Simulation failed:", err);
    } finally {
        await pool.end();
    }
}

main();
