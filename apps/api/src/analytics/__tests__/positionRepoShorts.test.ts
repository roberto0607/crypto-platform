/**
 * positionRepoShorts.test.ts — the stored positions row for a short, through
 * the live fill path (applyFillToPositionTx) and the rebuild replay
 * (replayTrades). Both must agree with the pure math (positionMath.test.ts).
 *
 * Hits the *_test database (fixtures + resetTestData).
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { pool } from "../../db/pool";
import { resetTestData } from "../../testing/resetDb";
import { createTestUser, createTestAssetAndPair } from "../../testing/fixtures";
import { applyFillToPositionTx, type PositionRow } from "../positionRepo";
import { replayTrades, type TradeRow } from "../../repair/positionRebuildService";

let userId: string;
let pairId: string;

beforeEach(async () => {
    await resetTestData();
    userId = (await createTestUser(pool)).id;
    pairId = (await createTestAssetAndPair(pool)).pair.id;
});

afterAll(async () => {
    await pool.end();
});

async function fill(side: "BUY" | "SELL", qty: string, price: string, ts: number, matchId: string | null = null): Promise<PositionRow> {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const row = await applyFillToPositionTx(client, { userId, pairId, side, qty, price, feeQuote: "0", ts, matchId });
        await client.query("COMMIT");
        return row;
    } catch (err) {
        await client.query("ROLLBACK");
        throw err;
    } finally {
        client.release();
    }
}

describe("applyFillToPositionTx — shorts", () => {
    it("short 2 @ 110, buy 1 @ 90 → realized +20, entry stays 110", async () => {
        await fill("SELL", "2", "110", 1_000);
        const row = await fill("BUY", "1", "90", 2_000);

        expect(row.base_qty).toBe("-1.00000000");
        expect(row.avg_entry_price).toBe("110.00000000");
        expect(row.realized_pnl_quote).toBe("20.00000000");
    });

    it("closing the rest of the short books the full P&L and resets the entry", async () => {
        await fill("SELL", "2", "110", 1_000);
        await fill("BUY", "1", "90", 2_000);
        const row = await fill("BUY", "1", "100", 3_000);

        expect(row.base_qty).toBe("0.00000000");
        expect(row.avg_entry_price).toBe("0.00000000");
        expect(row.realized_pnl_quote).toBe("30.00000000");
    });

    it("adding to a short averages the entry", async () => {
        await fill("SELL", "1", "100", 1_000);
        const row = await fill("SELL", "1", "120", 2_000);

        expect(row.base_qty).toBe("-2.00000000");
        expect(row.avg_entry_price).toBe("110.00000000");
        expect(row.realized_pnl_quote).toBe("0.00000000");
    });
});

describe("replayTrades — shorts (rebuild from fills)", () => {
    function trade(id: string, side: "BUY" | "SELL", qty: string, price: string): TradeRow {
        return {
            id, pair_id: "p", price, qty, quote_amount: (Number(qty) * Number(price)).toFixed(8),
            executed_at: new Date(Number(id) * 1000).toISOString(), user_side: side, user_fee_bps: 0, user_match_id: null,
        };
    }

    it("rebuilds the same row the live path writes", () => {
        const rebuilt = replayTrades("p", [trade("1", "SELL", "2", "110"), trade("2", "BUY", "1", "90")]);

        expect(rebuilt.baseQty).toBe("-1.00000000");
        expect(rebuilt.avgEntryPrice).toBe("110.00000000");
        expect(rebuilt.realizedPnlQuote).toBe("20.00000000");
    });
});
