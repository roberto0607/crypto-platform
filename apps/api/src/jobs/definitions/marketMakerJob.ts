import type { JobDefinition, JobContext } from "../jobTypes";
import { getSnapshot } from "../../market/snapshotStore";
import { placeOrderWithSnapshot, cancelOrderWithOutbox } from "../../trading/phase6OrderService";
import { listOrdersByUserId } from "../../trading/orderRepo";
import { listActivePairs, type PairRow } from "../../trading/pairRepo";
import { pool } from "../../db/pool";
import { config } from "../../config";
import { D, toFixed8 } from "../../utils/decimal";
import crypto from "node:crypto";

// ── Constants ──

const BOT_USER_ID = "00000000-0000-0000-0000-000000000001";

/**
 * Price levels on each side of the mid-price.
 * offsetBps = distance from mid in basis points.
 * qtyMultiplier = multiplied against the pair's base quantity.
 */
const LEVELS = [
    { offsetBps: 5, qtyMultiplier: 1.0 },   // 0.05% — tight
    { offsetBps: 15, qtyMultiplier: 1.5 },   // 0.15% — medium
    { offsetBps: 30, qtyMultiplier: 2.0 },   // 0.30% — wide
];

/** Base order quantity per pair (before multiplier). */
const BASE_QTY: Record<string, string> = {
    "BTC/USD": "0.50000000",
    "ETH/USD": "10.00000000",
    "SOL/USD": "100.00000000",
};

/** Re-quote threshold: cancel + re-place if mid moved more than this many bps. */
const REQUOTE_THRESHOLD_BPS = 50;

/** Funding amounts for bot wallets. */
const BOT_USD_BALANCE = "10000000.00000000";   // $10M
const BOT_CRYPTO_BALANCES: Record<string, string> = {
    "BTC": "100.00000000",
    "ETH": "5000.00000000",
    "SOL": "100000.00000000",
};

// ── State ──

let botInitialized = false;
/** Track the mid-price we last quoted at, per pair. */
const lastQuotedMid = new Map<string, string>();

// ── Job Definition ──

export const marketMakerJob: JobDefinition = {
    name: "market-maker",
    intervalSeconds: 10,
    timeoutMs: 25_000,
    async run(ctx) {
        if (config.disableMarketMaker) return;

        if (!botInitialized) {
            await ensureBotSetup(ctx);
            botInitialized = true;
        }

        const pairs = await listActivePairs();
        for (const pair of pairs) {
            try {
                await quotePair(pair, ctx);
            } catch (err: any) {
                ctx.logger.warn({ pair: pair.symbol, err: err.message }, "mm_quote_error");
            }
        }
    },
};

// ── Core Logic ──

async function quotePair(pair: PairRow, ctx: JobContext): Promise<void> {
    const baseQty = BASE_QTY[pair.symbol];
    if (!baseQty) return; // Unknown pair — skip

    // 1. Get live price from Kraken snapshot store
    const snapshot = await getSnapshot(pair.symbol);
    if (!snapshot) {
        // No live price available — don't quote stale prices
        return;
    }

    const mid = D(snapshot.last);
    if (mid.isZero()) return;

    // 2. Check if we need to re-quote (price moved significantly)
    const prevMid = lastQuotedMid.get(pair.id);
    if (prevMid) {
        const prevD = D(prevMid);
        const moveBps = mid.minus(prevD).abs().div(prevD).times(10000);
        if (moveBps.lt(REQUOTE_THRESHOLD_BPS)) {
            // Price hasn't moved enough — keep existing quotes
            return;
        }
    }

    // 3. Cancel existing bot orders for this pair
    const openOrders = await listOrdersByUserId(BOT_USER_ID, {
        pairId: pair.id,
        status: "OPEN",
    });

    for (const order of openOrders) {
        try {
            await cancelOrderWithOutbox(BOT_USER_ID, order.id);
        } catch {
            // Order may have been filled between check and cancel — safe to ignore
        }
    }

    // Also cancel partially filled orders
    const partialOrders = await listOrdersByUserId(BOT_USER_ID, {
        pairId: pair.id,
        status: "PARTIALLY_FILLED",
    });

    for (const order of partialOrders) {
        try {
            await cancelOrderWithOutbox(BOT_USER_ID, order.id);
        } catch {
            // Safe to ignore
        }
    }

    // 4. Place fresh orders at each level
    let placedCount = 0;

    for (const level of LEVELS) {
        const offset = mid.times(level.offsetBps).div(10000);
        const qty = toFixed8(D(baseQty).times(level.qtyMultiplier));

        // BUY side — below mid
        const bidPrice = mid.minus(offset).toFixed(2);
        try {
            await placeOrderWithSnapshot(
                BOT_USER_ID,
                { pairId: pair.id, side: "BUY", type: "LIMIT", qty, limitPrice: bidPrice },
                crypto.randomUUID(),
                `mm-${pair.symbol}-buy-${level.offsetBps}`,
                null, // free play
            );
            placedCount++;
        } catch (err: any) {
            ctx.logger.warn({ pair: pair.symbol, side: "BUY", level: level.offsetBps, err: err.message }, "mm_place_error");
        }

        // SELL side — above mid
        const askPrice = mid.plus(offset).toFixed(2);
        try {
            await placeOrderWithSnapshot(
                BOT_USER_ID,
                { pairId: pair.id, side: "SELL", type: "LIMIT", qty, limitPrice: askPrice },
                crypto.randomUUID(),
                `mm-${pair.symbol}-sell-${level.offsetBps}`,
                null, // free play
            );
            placedCount++;
        } catch (err: any) {
            ctx.logger.warn({ pair: pair.symbol, side: "SELL", level: level.offsetBps, err: err.message }, "mm_place_error");
        }
    }

    // 5. Only remember quoted mid if we actually placed orders
    if (placedCount > 0) {
        lastQuotedMid.set(pair.id, mid.toString());
        ctx.logger.info({ pair: pair.symbol, mid: mid.toFixed(2), orders: placedCount }, "mm_quoted");
    }
}

// ── Bot Setup (runs once) ──

async function ensureBotSetup(ctx: JobContext): Promise<void> {
    // 1. Verify bot user exists (migration 049 should have created it)
    const { rows: users } = await pool.query<{ id: string }>(
        `SELECT id FROM users WHERE id = $1`,
        [BOT_USER_ID],
    );

    if (users.length === 0) {
        ctx.logger.error("market_maker_bot_user_missing");
        throw new Error("Market maker bot user not found. Run migration 049.");
    }

    // 2. Ensure wallets exist with large balances
    const { rows: assets } = await pool.query<{ id: string; symbol: string }>(
        `SELECT id, symbol FROM assets WHERE symbol IN ('USD', 'BTC', 'ETH', 'SOL')`,
    );

    for (const asset of assets) {
        const targetBalance = asset.symbol === "USD"
            ? BOT_USD_BALANCE
            : (BOT_CRYPTO_BALANCES[asset.symbol] ?? "0");

        // Check if wallet exists (unique index uses COALESCE on competition_id)
        const { rows: existing } = await pool.query<{ id: string; balance: string }>(
            `SELECT id, balance FROM wallets
             WHERE user_id = $1 AND asset_id = $2 AND competition_id IS NULL`,
            [BOT_USER_ID, asset.id],
        );

        if (existing.length === 0) {
            const { rows: newWallet } = await pool.query<{ id: string }>(
                `INSERT INTO wallets (user_id, asset_id, balance, reserved, competition_id)
                 VALUES ($1, $2, $3, '0.00000000', NULL) RETURNING id`,
                [BOT_USER_ID, asset.id, targetBalance],
            );
            // Create matching ledger entry so reconciliation stays clean
            await pool.query(
                `INSERT INTO ledger_entries (wallet_id, entry_type, amount, balance_after, reference_id, reference_type, metadata)
                 VALUES ($1, 'ADMIN_CREDIT', $2, $2, gen_random_uuid(), 'SYSTEM', '{"reason":"mm_bot_funding"}')`,
                [newWallet[0].id, targetBalance],
            );
        } else if (D(existing[0].balance).lt(D(targetBalance))) {
            // Top up if balance is below target (e.g., after many fills)
            await pool.query(
                `UPDATE wallets SET balance = $1 WHERE id = $2`,
                [targetBalance, existing[0].id],
            );
            await pool.query(
                `INSERT INTO ledger_entries (wallet_id, entry_type, amount, balance_after, reference_id, reference_type, metadata)
                 VALUES ($1, 'ADMIN_CREDIT', $2, $3, gen_random_uuid(), 'SYSTEM', '{"reason":"mm_bot_topup"}')`,
                [existing[0].id, D(targetBalance).minus(D(existing[0].balance)).toFixed(8), targetBalance],
            );
        }
    }

    // 3. Set high quota limits so burst detection doesn't suspend the bot
    await pool.query(
        `INSERT INTO user_quotas (user_id, max_orders_per_min, max_open_orders, max_daily_orders, trading_enabled)
         VALUES ($1, 10000, 500, 100000, true)
         ON CONFLICT (user_id) DO UPDATE SET
             max_orders_per_min = 10000,
             max_open_orders = 500,
             max_daily_orders = 100000,
             trading_enabled = true`,
        [BOT_USER_ID],
    );

    ctx.logger.info("market_maker_bot_initialized");
}
