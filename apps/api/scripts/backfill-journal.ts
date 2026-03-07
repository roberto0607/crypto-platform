/**
 * Backfill script: processes existing trades into open_lots and closed_trades.
 *
 * Replays all historical fills in chronological order through processFillForJournal
 * to populate the FIFO journal for trades placed before the journal feature was deployed.
 *
 * Usage: cd apps/api && npx tsx scripts/backfill-journal.ts
 */

import { pool } from "../src/db/pool";
import { processFillForJournal } from "../src/journal/journalService";

async function backfill() {
    console.log("Starting journal backfill...");

    // Clear existing journal data to allow re-runs
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        await client.query("DELETE FROM closed_trades");
        await client.query("DELETE FROM open_lots");

        // Fetch all trades in chronological order
        const { rows: trades } = await client.query(`
            SELECT
                t.id, t.pair_id, t.buy_order_id, t.sell_order_id,
                t.price, t.qty, t.quote_amount, t.fee_amount,
                t.is_system_fill, t.executed_at,
                bo.user_id AS buy_user_id, bo.competition_id AS buy_comp_id,
                so.user_id AS sell_user_id, so.competition_id AS sell_comp_id
            FROM trades t
            LEFT JOIN orders bo ON bo.id = t.buy_order_id
            LEFT JOIN orders so ON so.id = t.sell_order_id
            ORDER BY t.executed_at ASC, t.id ASC
        `);

        console.log(`Found ${trades.length} trades to process`);

        let processed = 0;
        for (const trade of trades) {
            const filledAt = new Date(trade.executed_at);

            // Process buy side
            if (trade.buy_user_id) {
                await processFillForJournal(client, {
                    userId: trade.buy_user_id,
                    pairId: trade.pair_id,
                    fillId: trade.id,
                    side: "BUY",
                    price: trade.price,
                    qty: trade.qty,
                    feeQuote: trade.fee_amount,
                    filledAt,
                    competitionId: trade.buy_comp_id ?? null,
                });
            }

            // Process sell side
            if (trade.sell_user_id && !trade.is_system_fill) {
                await processFillForJournal(client, {
                    userId: trade.sell_user_id,
                    pairId: trade.pair_id,
                    fillId: trade.id,
                    side: "SELL",
                    price: trade.price,
                    qty: trade.qty,
                    feeQuote: trade.fee_amount,
                    filledAt,
                    competitionId: trade.sell_comp_id ?? null,
                });
            }

            processed++;
            if (processed % 100 === 0) {
                console.log(`  Processed ${processed}/${trades.length}`);
            }
        }

        await client.query("COMMIT");
        console.log(`Backfill complete. Processed ${processed} trades.`);

        // Show stats
        const { rows: stats } = await pool.query(`
            SELECT
                (SELECT COUNT(*) FROM closed_trades) AS closed_count,
                (SELECT COUNT(*) FROM open_lots WHERE qty_remaining > 0) AS open_count
        `);
        console.log(`  Closed trades created: ${stats[0].closed_count}`);
        console.log(`  Open lots remaining: ${stats[0].open_count}`);
    } catch (err) {
        await client.query("ROLLBACK");
        console.error("Backfill failed:", err);
        process.exit(1);
    } finally {
        client.release();
    }

    await pool.end();
}

backfill();
