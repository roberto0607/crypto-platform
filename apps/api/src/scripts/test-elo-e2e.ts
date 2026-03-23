/**
 * End-to-end test: 1v1 match ELO resolution.
 *
 * Simulates a complete match between two users, verifies ELO
 * changes, tier logic, idempotency, and the result API endpoint.
 * Cleans up all test data afterward.
 *
 * Usage: cd apps/api && npx tsx src/scripts/test-elo-e2e.ts
 */
import "dotenv/config";
import { pool, acquireClient } from "../db/pool";
import { resolveMatchElo } from "../competitions/eloService";

const USER_A_EMAIL = "rtirado0607@gmail.com";
const USER_B_EMAIL = "demo@demo.local";

interface UserState {
    id: string;
    email: string;
    elo_rating: number;
    win_count: number;
    loss_count: number;
    win_streak: number;
    loss_streak: number;
    tier: string;
}

const results: Array<{ name: string; pass: boolean; detail?: string }> = [];
function check(name: string, pass: boolean, detail?: string) {
    results.push({ name, pass, detail });
    const icon = pass ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
    console.log(`  [${icon}] ${name}${detail ? ` — ${detail}` : ""}`);
}

async function getUserState(userId: string): Promise<UserState> {
    const { rows } = await pool.query<UserState>(
        `SELECT u.id, u.email, u.elo_rating, u.win_count, u.loss_count,
                u.win_streak, u.loss_streak,
                COALESCE(ut.tier, 'ROOKIE') AS tier
         FROM users u
         LEFT JOIN user_tiers ut ON ut.user_id = u.id
         WHERE u.id = $1`,
        [userId],
    );
    return rows[0];
}

function printState(label: string, s: UserState) {
    console.log(`  ${label}: ELO=${s.elo_rating} tier=${s.tier} W=${s.win_count} L=${s.loss_count} WS=${s.win_streak} LS=${s.loss_streak}`);
}

async function main() {
    console.log("\n=== ELO E2E TEST ===\n");

    // ── Step 1: Load users ──
    const { rows: users } = await pool.query<{ id: string; email: string }>(
        `SELECT id, email FROM users WHERE email IN ($1, $2)`,
        [USER_A_EMAIL, USER_B_EMAIL],
    );
    const userA = users.find((u) => u.email === USER_A_EMAIL);
    const userB = users.find((u) => u.email === USER_B_EMAIL);
    if (!userA || !userB) {
        console.error("Missing test users. Need both", USER_A_EMAIL, "and", USER_B_EMAIL);
        process.exit(1);
    }
    console.log(`User A: ${userA.id} (${userA.email})`);
    console.log(`User B: ${userB.id} (${userB.email})\n`);

    // ── Step 2: Record BEFORE state ──
    const beforeA = await getUserState(userA.id);
    const beforeB = await getUserState(userB.id);
    console.log("BEFORE STATE:");
    printState("User A", beforeA);
    printState("User B", beforeB);

    // ── Step 3: Reset to known state ──
    console.log("\nResetting to test baseline (ROOKIE, ELO=1000, streaks=0)...");
    await pool.query(
        `UPDATE users SET elo_rating = 1000, win_count = 0, loss_count = 0, win_streak = 0, loss_streak = 0 WHERE id = ANY($1)`,
        [[userA.id, userB.id]],
    );
    await pool.query(
        `INSERT INTO user_tiers (user_id, tier) VALUES ($1, 'ROOKIE'), ($2, 'ROOKIE')
         ON CONFLICT (user_id) DO UPDATE SET tier = 'ROOKIE'`,
        [userA.id, userB.id],
    );

    // Get a trading pair for positions
    const { rows: pairs } = await pool.query<{ id: string; symbol: string }>(
        `SELECT id, symbol FROM trading_pairs WHERE is_active = true LIMIT 1`,
    );
    const pair = pairs[0];
    if (!pair) {
        console.error("No active trading pair found");
        process.exit(1);
    }

    let matchId: string | null = null;

    try {
        // ── Step 4: Create match directly ──
        console.log("\nCreating test match...");
        const { rows: matchRows } = await pool.query<{ id: string }>(
            `INSERT INTO matches (challenger_id, opponent_id, duration_hours, starting_capital, status, started_at, ends_at)
             VALUES ($1, $2, 24, 50000, 'ACTIVE', now() - interval '1 hour', now() - interval '1 minute')
             RETURNING id`,
            [userA.id, userB.id],
        );
        matchId = matchRows[0].id;
        console.log(`  Match ID: ${matchId}`);

        // Insert allowed pair
        await pool.query(
            `INSERT INTO match_allowed_pairs (match_id, pair_id) VALUES ($1, $2)`,
            [matchId, pair.id],
        );

        // ── Step 5: Insert simulated trades (match_positions) ──
        console.log("\nSimulating trades...");
        const capital = 50000;

        // User A: 4 winning trades (net positive)
        const tradesA = [
            { side: "LONG", entry: 70000, exit: 72000, qty: 0.05 },  // +100
            { side: "LONG", entry: 71000, exit: 72500, qty: 0.04 },  // +60
            { side: "SHORT", entry: 72000, exit: 71000, qty: 0.06 }, // +60
            { side: "LONG", entry: 71500, exit: 72000, qty: 0.1 },   // +50
        ];
        let totalPnlA = 0;
        for (const t of tradesA) {
            const pnl = t.side === "LONG"
                ? (t.exit - t.entry) * t.qty
                : (t.entry - t.exit) * t.qty;
            totalPnlA += pnl;
            await pool.query(
                `INSERT INTO match_positions (match_id, user_id, pair_id, side, entry_price, qty, exit_price, pnl, opened_at, closed_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() - interval '30 minutes', now() - interval '5 minutes')`,
                [matchId, userA.id, pair.id, t.side, t.entry, t.qty, t.exit, pnl],
            );
            console.log(`  A: ${t.side} ${t.qty} @ ${t.entry} → ${t.exit} = ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}`);
        }

        // User B: 3 losing trades (net negative)
        const tradesB = [
            { side: "LONG", entry: 72000, exit: 71000, qty: 0.05 },  // -50
            { side: "SHORT", entry: 71000, exit: 72000, qty: 0.04 }, // -40
            { side: "LONG", entry: 71500, exit: 71000, qty: 0.06 },  // -30
        ];
        let totalPnlB = 0;
        for (const t of tradesB) {
            const pnl = t.side === "LONG"
                ? (t.exit - t.entry) * t.qty
                : (t.entry - t.exit) * t.qty;
            totalPnlB += pnl;
            await pool.query(
                `INSERT INTO match_positions (match_id, user_id, pair_id, side, entry_price, qty, exit_price, pnl, opened_at, closed_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() - interval '30 minutes', now() - interval '5 minutes')`,
                [matchId, userB.id, pair.id, t.side, t.entry, t.qty, t.exit, pnl],
            );
            console.log(`  B: ${t.side} ${t.qty} @ ${t.entry} → ${t.exit} = ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}`);
        }

        const pnlPctA = (totalPnlA / capital) * 100;
        const pnlPctB = (totalPnlB / capital) * 100;
        console.log(`\n  User A total PnL: $${totalPnlA.toFixed(2)} (${pnlPctA.toFixed(2)}%)`);
        console.log(`  User B total PnL: $${totalPnlB.toFixed(2)} (${pnlPctB.toFixed(2)}%)`);

        // ── Step 6: Verify User A wins ──
        check("User A PnL > User B PnL", pnlPctA > pnlPctB, `${pnlPctA.toFixed(2)}% vs ${pnlPctB.toFixed(2)}%`);

        // ── Step 7: Complete the match (calls resolveMatchElo internally) ──
        console.log("\nCompleting match...");
        // Use completeMatch which calls resolveMatchElo
        const { completeMatch } = await import("../competitions/matchService");
        const completed = await completeMatch(matchId);
        console.log(`  Match status: ${completed.status}`);
        console.log(`  Winner: ${completed.winner_id}`);
        console.log(`  ELO delta: ${completed.elo_delta}`);

        check("Winner is User A", completed.winner_id === userA.id);

        // ── Step 8: Verify AFTER state ──
        console.log("\nAFTER STATE:");
        const afterA = await getUserState(userA.id);
        const afterB = await getUserState(userB.id);
        printState("User A", afterA);
        printState("User B", afterB);

        check("User A ELO increased by +15", afterA.elo_rating === 1015, `got ${afterA.elo_rating}`);
        check("User B ELO decreased by -3", afterB.elo_rating === 997, `got ${afterB.elo_rating}`);
        check("User A win_count = 1", afterA.win_count === 1, `got ${afterA.win_count}`);
        check("User B loss_count = 1", afterB.loss_count === 1, `got ${afterB.loss_count}`);
        check("User A win_streak = 1", afterA.win_streak === 1, `got ${afterA.win_streak}`);
        check("User B win_streak = 0", afterB.win_streak === 0, `got ${afterB.win_streak}`);
        check("User A loss_streak = 0", afterA.loss_streak === 0, `got ${afterA.loss_streak}`);
        check("User B loss_streak = 1", afterB.loss_streak === 1, `got ${afterB.loss_streak}`);

        // ── Step 9: Idempotency check ──
        console.log("\nIdempotency check — calling resolveMatchElo again...");
        const client = await acquireClient();
        try {
            await client.query("BEGIN");
            const secondResult = await resolveMatchElo(matchId, client);
            await client.query("COMMIT");
            check("Second resolveMatchElo is no-op", secondResult === null, "returned null");
        } finally {
            client.release();
        }

        const afterA2 = await getUserState(userA.id);
        const afterB2 = await getUserState(userB.id);
        check("User A ELO unchanged after 2nd call", afterA2.elo_rating === afterA.elo_rating, `${afterA2.elo_rating}`);
        check("User B ELO unchanged after 2nd call", afterB2.elo_rating === afterB.elo_rating, `${afterB2.elo_rating}`);

        // ── Step 10: Verify elo_resolved flag ──
        const { rows: matchCheck } = await pool.query<{ elo_resolved: boolean }>(
            `SELECT elo_resolved FROM matches WHERE id = $1`,
            [matchId],
        );
        check("elo_resolved = true", matchCheck[0]?.elo_resolved === true);

        // ── Step 11: Verify match_elo_results record ──
        const { rows: eloResults } = await pool.query(
            `SELECT * FROM match_elo_results WHERE match_id = $1`,
            [matchId],
        );
        check("match_elo_results record exists", eloResults.length === 1);
        if (eloResults[0]) {
            console.log("\n  match_elo_results:");
            console.log(`    winner_delta: +${eloResults[0].winner_delta}`);
            console.log(`    loser_delta: ${eloResults[0].loser_delta}`);
            console.log(`    winner_tier: ${eloResults[0].winner_tier_before} → ${eloResults[0].winner_tier_after}`);
            console.log(`    loser_tier: ${eloResults[0].loser_tier_before} → ${eloResults[0].loser_tier_after}`);
            console.log(`    streak_multiplier: ${eloResults[0].streak_multiplier}`);
            console.log(`    badges: ${JSON.stringify(eloResults[0].badges_earned)}`);
        }

    } finally {
        // ── Step 13-14: CLEANUP ──
        console.log("\nCLEANUP...");

        if (matchId) {
            await pool.query(`DELETE FROM match_elo_results WHERE match_id = $1`, [matchId]);
            await pool.query(`DELETE FROM elo_history WHERE match_id = $1`, [matchId]);
            await pool.query(`DELETE FROM match_positions WHERE match_id = $1`, [matchId]);
            await pool.query(`DELETE FROM match_allowed_pairs WHERE match_id = $1`, [matchId]);
            await pool.query(`DELETE FROM matches WHERE id = $1`, [matchId]);
        }

        // Restore original state
        await pool.query(
            `UPDATE users SET elo_rating = $1, win_count = $2, loss_count = $3, win_streak = $4, loss_streak = $5 WHERE id = $6`,
            [beforeA.elo_rating, beforeA.win_count, beforeA.loss_count, beforeA.win_streak, beforeA.loss_streak, userA.id],
        );
        await pool.query(
            `UPDATE users SET elo_rating = $1, win_count = $2, loss_count = $3, win_streak = $4, loss_streak = $5 WHERE id = $6`,
            [beforeB.elo_rating, beforeB.win_count, beforeB.loss_count, beforeB.win_streak, beforeB.loss_streak, userB.id],
        );
        await pool.query(
            `INSERT INTO user_tiers (user_id, tier) VALUES ($1, $2)
             ON CONFLICT (user_id) DO UPDATE SET tier = $2`,
            [userA.id, beforeA.tier],
        );
        await pool.query(
            `INSERT INTO user_tiers (user_id, tier) VALUES ($1, $2)
             ON CONFLICT (user_id) DO UPDATE SET tier = $2`,
            [userB.id, beforeB.tier],
        );

        // Delete any streak badges earned during test
        if (matchId) {
            await pool.query(
                `DELETE FROM user_badges WHERE metadata::text LIKE $1`,
                [`%${matchId}%`],
            );
        }

        console.log("CLEANUP COMPLETE — all test data removed, users restored.\n");
    }

    // ── Final Report ──
    console.log("═══════════════════════════════════════");
    console.log("  FINAL REPORT");
    console.log("═══════════════════════════════════════");
    const passed = results.filter((r) => r.pass).length;
    const failed = results.filter((r) => !r.pass).length;
    for (const r of results) {
        const icon = r.pass ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
        console.log(`  ${icon} ${r.name}`);
    }
    console.log(`\n  ${passed} passed, ${failed} failed\n`);

    if (failed > 0) process.exitCode = 1;
}

main()
    .catch((err) => {
        console.error("Test failed:", err);
        process.exitCode = 1;
    })
    .finally(() => pool.end());
