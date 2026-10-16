/**
 * liquidationQueryPlan.test.ts: the liquidation engine's hot query
 * (liquidation.findLiquidationCandidates, run per pair up to 4×/s) is served
 * by the partial indexes from migration 096, never a scan of positions.
 *
 * 40,000 position rows over two pairs: most SPOT (the bots, pre-leverage
 * rows), some flat, 5% open ISOLATED. PRINT_PLAN=1 prints EXPLAIN ANALYZE.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { pool } from "../../db/pool";
import { resetTestData, ensureMigrations } from "../../testing/resetDb";
import { createTestAssetAndPair } from "../../testing/fixtures";
import { LIQUIDATION_CANDIDATES_SQL } from "../liquidation";

let pairId: string;

beforeAll(async () => {
    await ensureMigrations();
    await resetTestData();
    pairId = (await createTestAssetAndPair(pool)).pair.id;
    const { rows: [eth] } = await pool.query<{ id: string }>(
        `INSERT INTO assets (symbol, name, decimals) VALUES ('ETH', 'Ether', 8) RETURNING id`);
    const { rows: [otherPair] } = await pool.query<{ id: string }>(
        `INSERT INTO trading_pairs (base_asset_id, quote_asset_id, symbol, is_active, last_price, maker_fee_bps, taker_fee_bps)
         SELECT $1, quote_asset_id, 'ETH/USD', true, 3000, 2, 5 FROM trading_pairs WHERE id = $2 RETURNING id`,
        [eth.id, pairId]);

    await pool.query(
        `INSERT INTO users (email, email_normalized, password_hash)
         SELECT 'plan' || g || '@test.com', 'plan' || g || '@test.com', 'x' FROM generate_series(1, 20000) g`);
    // Per user and pair: g % 20 = 0 → open ISOLATED long, = 1 → open ISOLATED
    // short, = 2..9 → flat, else SPOT with a position.
    await pool.query(
        `INSERT INTO positions (user_id, pair_id, base_qty, avg_entry_price, margin_mode, leverage, isolated_margin, liq_price, epoch)
         SELECT u.id, p.id,
                CASE WHEN g % 20 = 0 THEN 0.01 WHEN g % 20 = 1 THEN -0.01 WHEN g % 20 < 10 THEN 0 ELSE 0.5 END,
                83000,
                CASE WHEN g % 20 < 2 THEN 'ISOLATED' ELSE 'SPOT' END,
                CASE WHEN g % 20 < 2 THEN 10 ELSE 1 END,
                CASE WHEN g % 20 < 2 THEN 83 ELSE 0 END,
                CASE WHEN g % 20 = 0 THEN 70000 + (g % 9000) WHEN g % 20 = 1 THEN 87000 + (g % 9000) END,
                CASE WHEN g % 20 < 10 THEN 1 ELSE 0 END
         FROM (SELECT id, row_number() OVER (ORDER BY id) AS g FROM users WHERE email LIKE 'plan%') u
         CROSS JOIN (VALUES ($1::uuid), ($2::uuid)) p(id)`,
        [pairId, otherPair.id]);
    await pool.query(`ANALYZE positions`);
}, 120_000);

describe("the hot query", () => {
    it("uses idx_positions_liq_long and idx_positions_liq_short, no seq scan of positions", async () => {
        const { rows: [{ n }] } = await pool.query<{ n: string }>(`SELECT count(*) AS n FROM positions`);
        expect(Number(n)).toBe(40_000);

        const { rows } = await pool.query<{ "QUERY PLAN": string }>(
            `EXPLAIN (ANALYZE, BUFFERS) ${LIQUIDATION_CANDIDATES_SQL}`, [pairId, "75000.00000000"]);
        const plan = rows.map((r) => r["QUERY PLAN"]).join("\n");
        if (process.env.PRINT_PLAN === "1") console.log(plan);

        expect(plan).toContain("idx_positions_liq_long");
        expect(plan).toContain("idx_positions_liq_short");
        expect(plan).not.toMatch(/Seq Scan on positions/);
    });
});
