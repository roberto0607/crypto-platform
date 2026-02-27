import "dotenv/config";
import { pool } from "../db/pool";
import { placeOrder } from "../trading/matchingEngine";

/*
 * Demo scenario runner — CLI-based product demo.
 *
 * Assumes seed data is present (run seed.ts first).
 *
 * Flow:
 *   1. Look up demo user + BTC/USD pair
 *   2. Place MARKET BUY 0.1 BTC
 *   3. Place MARKET SELL 0.1 BTC
 *   4. Print position, realized PnL, equity snapshot
 */

const DEMO_EMAIL = "demo@demo.local";
const PAIR_SYMBOL = "BTC/USD";
const TRADE_QTY = "0.10000000";

async function demo(): Promise<void> {
  const nodeEnv = process.env.NODE_ENV ?? "development";
  if (nodeEnv === "production") {
    console.error("ABORT: demo cannot run in production.");
    process.exitCode = 1;
    await pool.end();
    return;
  }

  try {
    console.log("Running demo scenario...\n");

    // ── Look up demo user ──
    const userResult = await pool.query<{ id: string }>(
      `SELECT id FROM users WHERE email_normalized = $1`,
      [DEMO_EMAIL.toLowerCase()]
    );
    if (userResult.rows.length === 0) {
      console.error("Demo user not found. Run seed.ts first.");
      process.exitCode = 1;
      return;
    }
    const userId = userResult.rows[0].id;
    console.log(`Demo user: ${userId}`);

    // ── Look up pair ──
    const pairResult = await pool.query<{ id: string; last_price: string }>(
      `SELECT id, last_price FROM trading_pairs WHERE symbol = $1`,
      [PAIR_SYMBOL]
    );
    if (pairResult.rows.length === 0) {
      console.error("BTC/USD pair not found. Run seed.ts first.");
      process.exitCode = 1;
      return;
    }
    const pairId = pairResult.rows[0].id;
    const lastPrice = pairResult.rows[0].last_price;
    console.log(`Pair: ${PAIR_SYMBOL} (${pairId}), last_price=${lastPrice}\n`);

    // ── Step 1: MARKET BUY ──
    console.log(`Placing MARKET BUY ${TRADE_QTY} BTC...`);
    const buyResult = await placeOrder(userId, pairId, "BUY", "MARKET", TRADE_QTY);
    console.log(`  Order: ${buyResult.order.id} status=${buyResult.order.status}`);
    console.log(`  Fills: ${buyResult.fills.length}`);
    for (const fill of buyResult.fills) {
      console.log(`    Trade ${fill.id}: price=${fill.price} qty=${fill.qty} fee=${fill.fee_amount}`);
    }

    // ── Step 2: MARKET SELL ──
    console.log(`\nPlacing MARKET SELL ${TRADE_QTY} BTC...`);
    const sellResult = await placeOrder(userId, pairId, "SELL", "MARKET", TRADE_QTY);
    console.log(`  Order: ${sellResult.order.id} status=${sellResult.order.status}`);
    console.log(`  Fills: ${sellResult.fills.length}`);
    for (const fill of sellResult.fills) {
      console.log(`    Trade ${fill.id}: price=${fill.price} qty=${fill.qty} fee=${fill.fee_amount}`);
    }

    // ── Step 3: Position ──
    const posResult = await pool.query(
      `SELECT base_qty, avg_entry_price, realized_pnl_quote, fees_paid_quote
       FROM positions WHERE user_id = $1 AND pair_id = $2`,
      [userId, pairId]
    );
    if (posResult.rows.length > 0) {
      const pos = posResult.rows[0];
      console.log("\n── Position ──");
      console.log(`  base_qty:         ${pos.base_qty}`);
      console.log(`  avg_entry_price:  ${pos.avg_entry_price}`);
      console.log(`  realized_pnl:     ${pos.realized_pnl_quote}`);
      console.log(`  fees_paid:        ${pos.fees_paid_quote}`);
    }

    // ── Step 4: Equity snapshot ──
    const eqResult = await pool.query(
      `SELECT ts, equity_quote FROM equity_snapshots
       WHERE user_id = $1 ORDER BY ts DESC LIMIT 1`,
      [userId]
    );
    if (eqResult.rows.length > 0) {
      const eq = eqResult.rows[0];
      console.log("\n── Latest Equity Snapshot ──");
      console.log(`  ts:      ${eq.ts}`);
      console.log(`  equity:  ${eq.equity_quote}`);
    }

    // ── Wallet balances ──
    const walletResult = await pool.query(
      `SELECT w.balance, w.reserved, a.symbol
       FROM wallets w JOIN assets a ON a.id = w.asset_id
       WHERE w.user_id = $1 ORDER BY a.symbol`,
      [userId]
    );
    console.log("\n── Wallets ──");
    for (const w of walletResult.rows) {
      console.log(`  ${w.symbol}: balance=${w.balance} reserved=${w.reserved}`);
    }

    console.log("\nDemo complete.");
  } catch (err) {
    console.error("Demo failed:", err);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

demo();
