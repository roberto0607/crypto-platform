/**
 * Per-match wallets (migration 095).
 *
 * Lifecycle, all inside matchService's own transactions:
 *   accept → fundMatchWalletsTx: each player gets wallets scoped to the match
 *            (match_id = match), USD = starting_capital (MATCH_FUNDING) and a
 *            0-balance wallet per tradable base asset. New money — nothing is
 *            taken from free-play.
 *   trade  → the matching engine routes every match order to these wallets
 *            (WalletScope.matchId), so starting_capital is the cap and the 2×
 *            buying-power rule runs on the match's own wallet set.
 *   end    → settleMatchAccountsTx (matchService) runs, in this order:
 *            cancelMatchOrdersTx  — open match orders canceled, holds released
 *            lockMatchWalletsTx   — wallets locked BEFORE positions (trading
 *                                   locks pair → wallets → positions, so this
 *                                   order can't deadlock with an in-flight fill)
 *            positions force-closed, then settleMatchWalletsTx at the SAME
 *            fair price (closing a long sells at the bid, a short buys at the
 *            ask — the touch a real close would cross, never the last trade)
 *            closeMatchWalletsTx  — closed_at set, final balances kept
 *
 * Nothing ever transfers between a match's wallets and free-play.
 */
import type { PoolClient } from "pg";
import Decimal from "decimal.js";
import { D, toFixed8 } from "../utils/decimal.js";
import { tradableSymbols } from "../market/marketSymbols.js";
import { getMarketReference } from "../trading/priceCollar.js";
import { getSnapshot } from "../market/snapshotStore.js";
import { cancelOrderTx } from "../trading/matchingEngine.js";
import { createEvent, type AppEvent } from "../events/eventTypes.js";
import { walletUpdatedEventsTx } from "../wallets/walletRepo.js";

export const MATCH_FUNDING = "MATCH_FUNDING";
export const MATCH_SETTLEMENT = "MATCH_SETTLEMENT";

/**
 * Create and fund both players' match wallets. Throws if the USD asset isn't
 * tradable (a match can't start without a funded quote wallet).
 */
export async function fundMatchWalletsTx(
    client: PoolClient,
    matchId: string,
    userIds: string[],
    startingCapital: string,
): Promise<void> {
    const { rows } = await client.query<{ id: string; symbol: string }>(
        `INSERT INTO wallets (user_id, asset_id, balance, reserved, competition_id, match_id)
         SELECT u.id, a.id,
                CASE WHEN a.symbol = 'USD' THEN $3::numeric ELSE 0 END,
                0, NULL, $2
         FROM unnest($1::uuid[]) AS u(id)
         CROSS JOIN assets a
         WHERE a.id IN (
             SELECT base_asset_id FROM trading_pairs WHERE symbol = ANY($4)
             UNION
             SELECT quote_asset_id FROM trading_pairs WHERE symbol = ANY($4)
         )
         RETURNING id, (SELECT symbol FROM assets WHERE assets.id = wallets.asset_id) AS symbol`,
        [userIds, matchId, startingCapital, tradableSymbols()],
    );

    const usdWallets = rows.filter((r) => r.symbol === "USD");
    if (usdWallets.length !== userIds.length) throw new Error("match_wallets_missing");

    for (const w of usdWallets) {
        await client.query(
            `INSERT INTO ledger_entries (wallet_id, entry_type, amount, balance_after, reference_id, reference_type, metadata)
             VALUES ($1, $2, $3, $3, $4, 'MATCH', $5::jsonb)`,
            [w.id, MATCH_FUNDING, toFixed8(D(startingCapital)), matchId, JSON.stringify({ matchId })],
        );
    }
}

/**
 * Cancel every open order placed in this match and release its hold.
 * Returns the order.updated events to publish after COMMIT.
 */
export async function cancelMatchOrdersTx(client: PoolClient, matchId: string): Promise<AppEvent[]> {
    const { rows } = await client.query<{ id: string; user_id: string }>(
        `SELECT id, user_id FROM orders
         WHERE match_id = $1 AND status IN ('OPEN', 'PARTIALLY_FILLED')
         ORDER BY pair_id, created_at`,
        [matchId],
    );
    const events: AppEvent[] = [];
    for (const o of rows) {
        const { order } = await cancelOrderTx(client, o.user_id, o.id);
        events.push(createEvent("order.updated", {
            orderId: order.id,
            pairId: order.pair_id,
            side: order.side as "BUY" | "SELL",
            type: order.type as "MARKET" | "LIMIT",
            status: order.status,
            qty: order.qty,
            filledQty: order.qty_filled,
            limitPrice: order.limit_price ?? null,
        }, { userId: o.user_id }));
    }
    return events;
}

/** Lock every wallet of the match (sorted, one statement). */
export async function lockMatchWalletsTx(client: PoolClient, matchId: string): Promise<void> {
    await client.query(`SELECT id FROM wallets WHERE match_id = $1 ORDER BY id FOR UPDATE`, [matchId]);
}

// ── Fair close price ──

export type ClosePriceSource = "book" | "ticker" | "snapshot" | "trading_pairs.last_price" | "avg_entry_price";

/**
 * Prices a match-end close is booked at, shared by the positions force-close
 * and the wallet settlement so the score and the wallets agree. Keyed by
 * pair + direction; resolved once per pair per side for the whole match end.
 */
export class ClosePrices {
    private cache = new Map<string, { price: Decimal; source: ClosePriceSource }>();

    /**
     * The fair price to close a position in `pairId`: closing a LONG sells at
     * the bid, closing a SHORT buys at the ask — the live Kraken touch the
     * matching engine prices a market close at (priceCollar, #190), never a
     * last trade that a thin print could move. Fallbacks, in order: a ticker
     * snapshot's bid/ask (or last), trading_pairs.last_price, then
     * `entryFallback` (the position's own entry — a flat close).
     */
    async get(
        client: PoolClient,
        pairId: string,
        closingLong: boolean,
        entryFallback: string | null,
    ): Promise<{ price: Decimal; source: ClosePriceSource }> {
        const key = `${pairId}:${closingLong ? "long" : "short"}`;
        const hit = this.cache.get(key);
        if (hit) return hit;

        const { rows } = await client.query<{ symbol: string; last_price: string | null }>(
            `SELECT symbol, last_price::text FROM trading_pairs WHERE id = $1`,
            [pairId],
        );
        const pair = rows[0];
        let found: { price: Decimal; source: ClosePriceSource } | null = null;

        if (pair) {
            const ref = await getMarketReference(pairId, pair.symbol);
            if (ref) {
                found = { price: closingLong ? ref.bestBid : ref.bestAsk, source: ref.source === "book" ? "book" : "ticker" };
            }
            if (!found) {
                const snap = await getSnapshot(pair.symbol, 60_000);
                const side = closingLong ? snap?.bid : snap?.ask;
                const px = side ?? snap?.last;
                if (px && Number(px) > 0) found = { price: D(px), source: "snapshot" };
            }
            if (!found && pair.last_price && Number(pair.last_price) > 0) {
                found = { price: D(pair.last_price), source: "trading_pairs.last_price" };
            }
        }
        if (found) {
            this.cache.set(key, found);
            return found;
        }
        // Per-position fallback: not cached (each position has its own entry).
        return { price: D(entryFallback ?? "0"), source: "avg_entry_price" };
    }
}

/**
 * Settle the match's wallets to USD: every base wallet goes to 0, and its
 * USD wallet moves by balance × the fair close price (MATCH_SETTLEMENT on
 * both legs). Caller holds the wallet locks (lockMatchWalletsTx) and has
 * already canceled the match's orders, so nothing is reserved.
 */
export async function settleMatchWalletsTx(client: PoolClient, matchId: string, prices: ClosePrices): Promise<void> {
    const { rows } = await client.query<{
        id: string; user_id: string; balance: string; pair_id: string | null; usd_wallet_id: string | null;
    }>(
        `SELECT w.id, w.user_id, w.balance::text,
                tp.id AS pair_id, usd.id AS usd_wallet_id
         FROM wallets w
         JOIN assets a ON a.id = w.asset_id AND a.symbol <> 'USD'
         LEFT JOIN wallets usd
           ON usd.match_id = w.match_id AND usd.user_id = w.user_id
          AND usd.asset_id = (SELECT id FROM assets WHERE symbol = 'USD')
         LEFT JOIN LATERAL (
             SELECT id FROM trading_pairs
             WHERE base_asset_id = w.asset_id AND quote_asset_id = usd.asset_id
             ORDER BY is_active DESC LIMIT 1
         ) tp ON true
         WHERE w.match_id = $1 AND w.balance <> 0
         ORDER BY w.id`,
        [matchId],
    );

    for (const w of rows) {
        if (!w.pair_id || !w.usd_wallet_id) throw new Error("match_settlement_pair_missing");
        const qty = D(w.balance);
        const { rows: pos } = await client.query<{ avg_entry_price: string }>(
            `SELECT avg_entry_price::text FROM positions WHERE match_id = $1 AND user_id = $2 AND pair_id = $3`,
            [matchId, w.user_id, w.pair_id],
        );
        const { price, source } = await prices.get(client, w.pair_id, qty.isPositive(), pos[0]?.avg_entry_price ?? null);
        const proceeds = toFixed8(qty.mul(price)); // negative when buying back a short
        const meta = JSON.stringify({ matchId, pairId: w.pair_id, qty: toFixed8(qty), price: toFixed8(price), priceSource: source });

        await client.query(
            `WITH u AS (UPDATE wallets SET balance = 0 WHERE id = $1 RETURNING balance)
             INSERT INTO ledger_entries (wallet_id, entry_type, amount, balance_after, reference_id, reference_type, metadata)
             SELECT $1, $2, $3, u.balance, $4, 'MATCH', $5::jsonb FROM u`,
            [w.id, MATCH_SETTLEMENT, toFixed8(qty.neg()), matchId, meta],
        );
        await client.query(
            `WITH u AS (UPDATE wallets SET balance = balance + $3 WHERE id = $1 RETURNING balance)
             INSERT INTO ledger_entries (wallet_id, entry_type, amount, balance_after, reference_id, reference_type, metadata)
             SELECT $1, $2, $3, u.balance, $4, 'MATCH', $5::jsonb FROM u`,
            [w.usd_wallet_id, MATCH_SETTLEMENT, proceeds, matchId, meta],
        );
    }
}

/** Close the match's wallets (final balances kept). Returns wallet.updated events. */
export async function closeMatchWalletsTx(client: PoolClient, matchId: string): Promise<AppEvent[]> {
    const { rows } = await client.query<{ id: string }>(
        `UPDATE wallets SET closed_at = now() WHERE match_id = $1 AND closed_at IS NULL RETURNING id`,
        [matchId],
    );
    return walletUpdatedEventsTx(client, rows.map((r) => r.id), MATCH_SETTLEMENT);
}
