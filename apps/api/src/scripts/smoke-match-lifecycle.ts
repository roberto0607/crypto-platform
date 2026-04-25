/**
 * smoke-match-lifecycle.ts — end-to-end smoke test of match-scoped positions.
 *
 * Exercises the real product code (not mocks) against a live Postgres:
 *   1. Create two users + wallets + disposable BTC/USD pair + ACTIVE match
 *   2. applyFillToPositionTx with matchId populated → match-scoped positions row
 *   3. Verify no free-play row exists for the same (user, pair)
 *   4. Bump trading_pairs.last_price to 51500 (+$1500/BTC)
 *   5. completeMatch → force-close books +150 realized P&L, match COMPLETED,
 *      challenger wins, challenger_pnl_pct > 0
 *   6. Verify exactly one is_system_fill=true trade row was synthesized
 *   7. Clean up all rows in FK-safe order
 *
 * Throws on any assertion failure (non-zero exit). Runs in ~1 second
 * against the local DB.
 *
 * Usage:
 *   cd apps/api
 *   DATABASE_URL="postgresql://cp:cp@localhost:5433/cp" npx tsx src/scripts/smoke-match-lifecycle.ts
 */

import "dotenv/config";
import { pool } from "../db/pool";
import { applyFillToPositionTx } from "../analytics/positionRepo";
import { completeMatch } from "../competitions/matchService";

function assert(cond: unknown, msg: string): asserts cond {
    if (!cond) {
        console.error(`\n[FAIL] ${msg}\n`);
        throw new Error(msg);
    }
    console.log(`  [ok] ${msg}`);
}

async function main(): Promise<void> {
    const uid = Math.random().toString(36).slice(2, 7);
    console.log(`[smoke-match-lifecycle] run id=${uid}\n`);

    // Capture everything we create so cleanup is deterministic on any failure.
    const created = {
        challengerId: "",
        opponentId: "",
        baseAssetId: "",
        quoteAssetId: "",
        pairId: "",
        matchId: "",
        chUsdWalletId: "",
        chBtcWalletId: "",
        opUsdWalletId: "",
        opBtcWalletId: "",
    };

    try {
        console.log("── Step 1-2: create users + wallets ──");
        const { rows: chRows } = await pool.query<{ id: string }>(
            `INSERT INTO users (email, email_normalized, password_hash, role)
             VALUES ($1, LOWER($1), 'test-hash', 'USER') RETURNING id`,
            [`smoke-ch-${uid}@test.local`],
        );
        created.challengerId = chRows[0]!.id;

        const { rows: opRows } = await pool.query<{ id: string }>(
            `INSERT INTO users (email, email_normalized, password_hash, role)
             VALUES ($1, LOWER($1), 'test-hash', 'USER') RETURNING id`,
            [`smoke-op-${uid}@test.local`],
        );
        created.opponentId = opRows[0]!.id;

        console.log("── Step 3: create disposable BTC/USD pair ──");
        const { rows: baseAssetRows } = await pool.query<{ id: string }>(
            `INSERT INTO assets (symbol, name, decimals) VALUES ($1, $2, 8) RETURNING id`,
            [`SB${uid.toUpperCase()}`, `BTC-smoke-${uid}`],
        );
        created.baseAssetId = baseAssetRows[0]!.id;

        const { rows: quoteAssetRows } = await pool.query<{ id: string }>(
            `INSERT INTO assets (symbol, name, decimals) VALUES ($1, $2, 2) RETURNING id`,
            [`SU${uid.toUpperCase()}`, `USD-smoke-${uid}`],
        );
        created.quoteAssetId = quoteAssetRows[0]!.id;

        const { rows: pairRows } = await pool.query<{ id: string }>(
            `INSERT INTO trading_pairs (base_asset_id, quote_asset_id, symbol, is_active, last_price, fee_bps)
             VALUES ($1, $2, $3, true, '50000.00000000', 30) RETURNING id`,
            [created.baseAssetId, created.quoteAssetId, `SMK${uid.toUpperCase()}/USD`],
        );
        created.pairId = pairRows[0]!.id;

        // $50K USD starting balances per the scenario spec.
        async function createWallet(userId: string, assetId: string, balance: string): Promise<string> {
            const { rows } = await pool.query<{ id: string }>(
                `INSERT INTO wallets (user_id, asset_id, balance, reserved, competition_id, match_id)
                 VALUES ($1, $2, $3, '0', NULL, NULL) RETURNING id`,
                [userId, assetId, balance],
            );
            return rows[0]!.id;
        }
        created.chUsdWalletId = await createWallet(created.challengerId, created.quoteAssetId, "50000.00000000");
        created.chBtcWalletId = await createWallet(created.challengerId, created.baseAssetId, "0.00000000");
        created.opUsdWalletId = await createWallet(created.opponentId, created.quoteAssetId, "50000.00000000");
        created.opBtcWalletId = await createWallet(created.opponentId, created.baseAssetId, "0.00000000");

        console.log("── Step 4: create ACTIVE match ──");
        const { rows: matchRows } = await pool.query<{ id: string }>(
            `INSERT INTO matches (challenger_id, opponent_id, duration_hours, starting_capital, status, started_at, ends_at)
             VALUES ($1, $2, 24, '50000', 'ACTIVE', now() - interval '1 hour', now() + interval '23 hours')
             RETURNING id`,
            [created.challengerId, created.opponentId],
        );
        created.matchId = matchRows[0]!.id;
        console.log(`  matchId=${created.matchId}`);

        console.log("\n── Step 5: fill into match-scoped position ──");
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            await applyFillToPositionTx(client, {
                userId: created.challengerId,
                pairId: created.pairId,
                side: "BUY",
                qty: "0.10000000",
                price: "50000.00000000",
                feeQuote: "0",
                ts: Date.now(),
                competitionId: null,
                matchId: created.matchId,
            });
            await client.query("COMMIT");
        } finally {
            client.release();
        }

        console.log("\n── Step 6-7: position scoping assertions ──");
        const { rows: scopedPositionRows } = await pool.query<{
            base_qty: string; avg_entry_price: string;
        }>(
            `SELECT base_qty::text, avg_entry_price::text
             FROM positions
             WHERE user_id = $1 AND match_id = $2`,
            [created.challengerId, created.matchId],
        );
        assert(scopedPositionRows.length === 1, "exactly one match-scoped positions row");
        assert(
            Math.abs(parseFloat(scopedPositionRows[0]!.base_qty) - 0.1) < 1e-8,
            `base_qty = 0.1 (got ${scopedPositionRows[0]!.base_qty})`,
        );
        assert(
            Math.abs(parseFloat(scopedPositionRows[0]!.avg_entry_price) - 50000) < 1e-2,
            `avg_entry_price = 50000 (got ${scopedPositionRows[0]!.avg_entry_price})`,
        );

        const { rows: freePlayRows } = await pool.query(
            `SELECT 1 FROM positions
             WHERE user_id = $1 AND pair_id = $2 AND match_id IS NULL`,
            [created.challengerId, created.pairId],
        );
        assert(freePlayRows.length === 0, "no free-play positions row for same (user, pair)");

        console.log("\n── Step 8: move price to 51500 ──");
        await pool.query(
            `UPDATE trading_pairs SET last_price = '51500.00000000' WHERE id = $1`,
            [created.pairId],
        );

        console.log("\n── Step 9: completeMatch ──");
        const completedMatch = await completeMatch(created.matchId);

        console.log("\n── Step 10: position closed + PnL booked ──");
        const { rows: closedRows } = await pool.query<{
            base_qty: string; realized_pnl_quote: string; avg_entry_price: string;
        }>(
            `SELECT base_qty::text, realized_pnl_quote::text, avg_entry_price::text
             FROM positions
             WHERE user_id = $1 AND match_id = $2`,
            [created.challengerId, created.matchId],
        );
        assert(closedRows.length === 1, "position row still present post-close");
        assert(
            Math.abs(parseFloat(closedRows[0]!.base_qty)) < 1e-8,
            `base_qty = 0 (got ${closedRows[0]!.base_qty})`,
        );
        assert(
            Math.abs(parseFloat(closedRows[0]!.realized_pnl_quote) - 150) < 1e-2,
            `realized_pnl_quote ≈ 150 (got ${closedRows[0]!.realized_pnl_quote})`,
        );

        console.log("\n── Step 11: match row state ──");
        assert(completedMatch.status === "COMPLETED", `match.status = COMPLETED (got ${completedMatch.status})`);
        assert(
            completedMatch.winner_id === created.challengerId,
            `winner_id = challenger (${created.challengerId}), got ${completedMatch.winner_id}`,
        );
        assert(
            completedMatch.challenger_pnl_pct !== null,
            "challenger_pnl_pct is not null",
        );
        assert(
            parseFloat(completedMatch.challenger_pnl_pct ?? "0") > 0,
            `challenger_pnl_pct > 0 (got ${completedMatch.challenger_pnl_pct})`,
        );

        console.log("\n── Step 12: exactly one system-fill trade for the pair ──");
        const { rows: tradeRows } = await pool.query<{ count: string }>(
            `SELECT count(*)::text AS count FROM trades
             WHERE pair_id = $1 AND is_system_fill = true`,
            [created.pairId],
        );
        assert(
            tradeRows[0]!.count === "1",
            `exactly 1 system-fill trade (got ${tradeRows[0]!.count})`,
        );

        console.log("\n[PASS] all 7c assertions green\n");
    } finally {
        console.log("\n── Step 13: cleanup ──");
        if (created.matchId) {
            await pool.query(`DELETE FROM match_elo_results WHERE match_id = $1`, [created.matchId]);
            await pool.query(`DELETE FROM elo_history WHERE match_id = $1`, [created.matchId]);
            await pool.query(`DELETE FROM match_positions WHERE match_id = $1`, [created.matchId]);
            await pool.query(`DELETE FROM match_allowed_pairs WHERE match_id = $1`, [created.matchId]);
        }
        if (created.pairId) {
            await pool.query(
                `DELETE FROM trades
                 WHERE pair_id = $1
                    OR buy_order_id IN (SELECT id FROM orders WHERE pair_id = $1)
                    OR sell_order_id IN (SELECT id FROM orders WHERE pair_id = $1)`,
                [created.pairId],
            );
            await pool.query(`DELETE FROM orders WHERE pair_id = $1`, [created.pairId]);
            await pool.query(`DELETE FROM positions WHERE pair_id = $1`, [created.pairId]);
            await pool.query(
                `DELETE FROM equity_snapshots WHERE user_id = $1 OR user_id = $2`,
                [created.challengerId, created.opponentId],
            );
            await pool.query(`DELETE FROM ledger_entries WHERE wallet_id = ANY($1)`, [[
                created.chUsdWalletId, created.chBtcWalletId,
                created.opUsdWalletId, created.opBtcWalletId,
            ]]);
            // Delete wallets by id — wallets has no pair_id column, only asset_id.
            await pool.query(`DELETE FROM wallets WHERE id = ANY($1)`, [[
                created.chUsdWalletId, created.chBtcWalletId,
                created.opUsdWalletId, created.opBtcWalletId,
            ]]);
            await pool.query(`DELETE FROM trading_pairs WHERE id = $1`, [created.pairId]);
        }
        if (created.matchId) {
            await pool.query(`DELETE FROM matches WHERE id = $1`, [created.matchId]);
        }
        if (created.baseAssetId || created.quoteAssetId) {
            await pool.query(`DELETE FROM assets WHERE id = ANY($1)`, [[
                created.baseAssetId, created.quoteAssetId,
            ]]);
        }
        if (created.challengerId || created.opponentId) {
            await pool.query(`DELETE FROM users WHERE id = ANY($1)`, [[
                created.challengerId, created.opponentId,
            ]]);
        }
        console.log("  cleanup complete.");
        await pool.end();
    }
}

main().catch((err) => {
    console.error("[smoke-match-lifecycle] error:", err);
    process.exit(1);
});
