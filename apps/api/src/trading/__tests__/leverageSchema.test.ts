/**
 * leverageSchema.test.ts — migration 096 is additive: every new column
 * defaults to today's behavior (SPOT, 1x, no margin), and the new
 * constraints keep bad values out. Hits the *_test database.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { pool } from "../../db/pool";
import { resetTestData } from "../../testing/resetDb";
import { createTestUser, createTestAssetAndPair, createTestWallets, seedTestOrder } from "../../testing/fixtures";

let userId: string;
let opponentId: string;
let pairId: string;
let usdWalletId: string;

beforeEach(async () => {
    await resetTestData();
    userId = (await createTestUser(pool)).id;
    opponentId = (await createTestUser(pool)).id;
    const { btcAsset, usdAsset, pair } = await createTestAssetAndPair(pool);
    pairId = pair.id;
    usdWalletId = (await createTestWallets(pool, userId, btcAsset.id, usdAsset.id)).usdWallet.id;
});

afterAll(async () => {
    await pool.end();
});

async function insertMatch(): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO matches (challenger_id, opponent_id, duration_hours, starting_capital, status)
         VALUES ($1, $2, 24, '10000', 'PENDING') RETURNING id`,
        [userId, opponentId],
    );
    return rows[0]!.id;
}

async function insertLiquidation(mode: string, epoch = 1): Promise<void> {
    await pool.query(
        `INSERT INTO liquidations (mode, user_id, pair_id, position_epoch, side, qty, entry_price,
                                   leverage, margin, liq_price, mark_price)
         VALUES ($1, $2, $3, $4, 'LONG', 0.00602409, 83000, 10, 49.999947, 75075.37688442, 75070)`,
        [mode, userId, pairId, epoch],
    );
}

describe("new columns default to today's behavior", () => {
    it("positions: SPOT, 1x, no margin, no liq price, epoch 0", async () => {
        const { rows } = await pool.query(
            `INSERT INTO positions (user_id, pair_id, base_qty, avg_entry_price)
             VALUES ($1, $2, 1, 100)
             RETURNING margin_mode, leverage::text, isolated_margin::text, liq_price, epoch, opened_at`,
            [userId, pairId],
        );
        expect(rows[0]).toEqual({
            margin_mode: "SPOT", leverage: "1.00", isolated_margin: "0.00000000",
            liq_price: null, epoch: 0, opened_at: null,
        });
    });

    it("trading_pairs: 0.5% maintenance margin, 10x max", async () => {
        const { rows } = await pool.query(
            `SELECT maintenance_margin_bps, max_leverage::text FROM trading_pairs WHERE id = $1`,
            [pairId],
        );
        expect(rows[0]).toEqual({ maintenance_margin_bps: 50, max_leverage: "10.00" });
    });

    it("matches: SPOT at 1x", async () => {
        const matchId = await insertMatch();
        const { rows } = await pool.query(`SELECT margin_mode, max_leverage::text FROM matches WHERE id = $1`, [matchId]);
        expect(rows[0]).toEqual({ margin_mode: "SPOT", max_leverage: "1.00" });
    });

    it("orders: 1x", async () => {
        const order = await seedTestOrder(pool, userId, pairId, "BUY", "LIMIT", "1", "100");
        expect(order.leverage).toBe("1.00");
    });

    it("closed_trades: 1x, no margin, no close reason, no match", async () => {
        const { rows } = await pool.query(
            `INSERT INTO closed_trades (user_id, pair_id, direction, entry_fill_ids, entry_qty, entry_avg_price,
                                        entry_at, exit_fill_ids, exit_qty, exit_avg_price, exit_at,
                                        gross_pnl, total_fees, net_pnl, return_pct, holding_seconds)
             VALUES ($1, $2, 'LONG', ARRAY[gen_random_uuid()], 1, 100, now(), ARRAY[gen_random_uuid()], 1, 110, now(),
                     10, 0, 10, 10, 60)
             RETURNING leverage::text, margin, close_reason, return_on_margin_pct, match_id`,
            [userId, pairId],
        );
        expect(rows[0]).toEqual({ leverage: "1.00", margin: null, close_reason: null, return_on_margin_pct: null, match_id: null });
    });
});

describe("constraints", () => {
    it("rejects leverage below 1 on positions, orders and matches", async () => {
        await expect(pool.query(
            `INSERT INTO positions (user_id, pair_id, leverage) VALUES ($1, $2, 0.5)`, [userId, pairId],
        )).rejects.toThrow(/positions_leverage_check/);
        const order = await seedTestOrder(pool, userId, pairId, "BUY", "LIMIT", "1", "100");
        await expect(pool.query(`UPDATE orders SET leverage = 0 WHERE id = $1`, [order.id]))
            .rejects.toThrow(/orders_leverage_check/);
        const matchId = await insertMatch();
        await expect(pool.query(`UPDATE matches SET max_leverage = 0.9 WHERE id = $1`, [matchId]))
            .rejects.toThrow(/matches_max_leverage_check/);
    });

    it("rejects an unknown margin mode", async () => {
        await expect(pool.query(
            `INSERT INTO positions (user_id, pair_id, margin_mode) VALUES ($1, $2, 'CROSS')`, [userId, pairId],
        )).rejects.toThrow(/positions_margin_mode_check/);
    });

    it("rejects negative margin", async () => {
        await expect(pool.query(
            `INSERT INTO positions (user_id, pair_id, isolated_margin) VALUES ($1, $2, -1)`, [userId, pairId],
        )).rejects.toThrow(/positions_isolated_margin_check/);
    });

    it("a pair can't be liquidatable at open: maintenance margin × max leverage < 100%", async () => {
        await expect(pool.query(
            `UPDATE trading_pairs SET maintenance_margin_bps = 100, max_leverage = 100 WHERE id = $1`, [pairId],
        )).rejects.toThrow(/trading_pairs_margin_params_check/);
        // The approved SOL setting (1% at 10x) is allowed.
        await pool.query(`UPDATE trading_pairs SET maintenance_margin_bps = 100, max_leverage = 10 WHERE id = $1`, [pairId]);
    });

    it("rejects an unknown close reason", async () => {
        await expect(pool.query(
            `INSERT INTO closed_trades (user_id, pair_id, direction, entry_fill_ids, entry_qty, entry_avg_price,
                                        entry_at, exit_fill_ids, exit_qty, exit_avg_price, exit_at,
                                        gross_pnl, total_fees, net_pnl, return_pct, holding_seconds, close_reason)
             VALUES ($1, $2, 'LONG', ARRAY[gen_random_uuid()], 1, 100, now(), ARRAY[gen_random_uuid()], 1, 110, now(),
                     10, 0, 10, 10, 60, 'MARGIN_CALL')`,
            [userId, pairId],
        )).rejects.toThrow(/closed_trades_close_reason_check/);
    });
});

describe("ledger entry types", () => {
    it.each(["MARGIN_LOCK", "MARGIN_RELEASE", "REALIZED_PNL", "LIQUIDATION_SHORTFALL", "POSITION_CONVERSION", "MATCH_SETTLEMENT"])(
        "accepts %s",
        async (type) => {
            await pool.query(
                `INSERT INTO ledger_entries (wallet_id, entry_type, amount, balance_after) VALUES ($1, $2, 1, 1)`,
                [usdWalletId, type],
            );
        },
    );

    it("still rejects an unknown type", async () => {
        await expect(pool.query(
            `INSERT INTO ledger_entries (wallet_id, entry_type, amount, balance_after) VALUES ($1, 'FUNDING', 1, 1)`,
            [usdWalletId],
        )).rejects.toThrow(/ledger_entry_type_check/);
    });
});

describe("liquidations", () => {
    it("one row per position episode per mode", async () => {
        await insertLiquidation("LOG_ONLY", 1);
        await expect(insertLiquidation("LOG_ONLY", 1)).rejects.toThrow(/liquidations_once/);
        await insertLiquidation("EXECUTED", 1);   // same episode, other mode
        await insertLiquidation("LOG_ONLY", 2);   // next episode
        const { rows } = await pool.query(`SELECT count(*)::int AS n, sum(shortfall)::text AS s FROM liquidations`);
        expect(rows[0]).toEqual({ n: 3, s: "0.00000000" });
    });

    it("rejects an unknown mode", async () => {
        await expect(insertLiquidation("DRY_RUN")).rejects.toThrow(/liquidations_mode_check/);
    });
});
