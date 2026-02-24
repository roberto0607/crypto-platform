/**
 * Post-trade financial integrity invariant checks.
 *
 * Runs inside the matching transaction (after fills, before COMMIT).
 *   - Development: throws on first violation (fail fast).
 *   - Production:  logs violations as warnings (does not abort trade).
 */
import type { PoolClient } from "pg";
import { D, ZERO } from "../utils/decimal";

const ENFORCE = process.env.NODE_ENV !== "production";

type Violation = { type: string; detail: string };

/**
 * Verify wallet, order, and ledger invariants for a completed trade batch.
 *
 * @param walletIds  All wallets touched by the transaction
 * @param orderIds   Taker order + all matched maker orders
 * @param tradeIds   All trade (fill) IDs created in this transaction
 */
export async function verifyPostTradeInvariants(
    client: PoolClient,
    walletIds: string[],
    orderIds: string[],
    tradeIds: string[],
): Promise<void> {
    const violations: Violation[] = [];

    // ── 1. Wallet state: balance >= 0, reserved >= 0, reserved <= balance ──
    const wRows = await client.query<{ id: string; balance: string; reserved: string }>(
        `SELECT id, balance::text, reserved::text
         FROM wallets
         WHERE id = ANY($1)
           AND (balance < 0 OR reserved < 0 OR reserved > balance)`,
        [walletIds],
    );
    for (const w of wRows.rows) {
        violations.push({
            type: "WALLET_STATE",
            detail: `wallet ${w.id}: balance=${w.balance} reserved=${w.reserved}`,
        });
    }

    // ── 2. Order state: reserved_consumed <= reserved_amount ──
    const oRows = await client.query<{
        id: string;
        reserved_amount: string;
        reserved_consumed: string;
    }>(
        `SELECT id, reserved_amount::text, reserved_consumed::text
         FROM orders
         WHERE id = ANY($1)
           AND reserved_consumed > reserved_amount`,
        [orderIds],
    );
    for (const o of oRows.rows) {
        violations.push({
            type: "ORDER_OVER_CONSUMED",
            detail: `order ${o.id}: consumed=${o.reserved_consumed} > reserved=${o.reserved_amount}`,
        });
    }

    // ── 3. Per non-system trade: ledger balance per asset ──
    //  Base asset net  = 0        (qty in == qty out)
    //  Quote asset net = -fee     (fee extracted from the system)
    for (const tradeId of tradeIds) {
        const tRow = await client.query<{ fee_amount: string; is_system_fill: boolean }>(
            `SELECT fee_amount::text, is_system_fill FROM trades WHERE id = $1`,
            [tradeId],
        );
        if (tRow.rows.length === 0) continue;
        const { fee_amount, is_system_fill } = tRow.rows[0];
        if (is_system_fill) continue; // system fills have no counterparty

        const ledger = await client.query<{ asset_id: string; net: string }>(
            `SELECT w.asset_id, SUM(le.amount)::text AS net
             FROM ledger_entries le
             JOIN wallets w ON w.id = le.wallet_id
             WHERE le.reference_id = $1
             GROUP BY w.asset_id`,
            [tradeId],
        );

        const fee = D(fee_amount);
        for (const row of ledger.rows) {
            const net = D(row.net);
            // Base asset: credits and debits cancel → net == 0
            if (net.eq(ZERO)) continue;
            // Quote asset: fee is extracted → net == -fee
            if (net.neg().eq(fee)) continue;

            violations.push({
                type: "TRADE_IMBALANCE",
                detail: `trade ${tradeId} asset ${row.asset_id}: net=${row.net} (expected 0 or -${fee_amount})`,
            });
        }
    }

    if (violations.length === 0) return;

    const msg = violations.map((v) => `  [${v.type}] ${v.detail}`).join("\n");

    if (ENFORCE) {
        throw new Error(`invariant_violation:\n${msg}`);
    }
    console.error(`[INVARIANT WARNING] Post-trade check failed:\n${msg}`);
}
