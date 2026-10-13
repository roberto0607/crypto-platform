/**
 * Legacy match footprint report (read-only).
 *
 * Before migration 095 a match had no wallets of its own: every match fill
 * debited and credited the players' FREE-PLAY wallets, and the match-end
 * force-close only rewrote positions. So each ended match left a net effect
 * in free-play — cash moved by its trades, and base left behind by any
 * position force-closed at match end (a force-closed short is still a
 * negative base balance in free-play).
 *
 * This reports that effect per ended match and player: the net ledger
 * movement on the player's free-play wallets from trades of their own match
 * orders, per asset, plus a value at today's price. It changes nothing.
 * Counterparty legs are excluded (a match taker filled by the MM bot moves
 * the bot's free-play wallets too — those aren't the match's footprint).
 */
import type { Pool, PoolClient } from "pg";
import { D, ZERO } from "../utils/decimal";

export type LegacyFootprintRow = {
    match_id: string;
    status: string;
    completed_at: string | null;
    user_id: string;
    email: string;
    asset: string;
    net: string;
    entries: number;
    /** USD value of `net` at the pair's current last_price (USD itself: net). Null when unpriced. */
    value_usd: string | null;
};

export type LegacyFootprint = {
    match_id: string;
    status: string;
    completed_at: string | null;
    user_id: string;
    email: string;
    assets: { asset: string; net: string; entries: number; value_usd: string | null }[];
    /** Σ value_usd over priced assets: the net amount this match left in free-play, at today's prices. */
    total_value_usd: string;
    unpriced_assets: string[];
};

/** Ledger rows for every ended match (or one, with `matchId`), per player and asset. */
export async function legacyFootprintRows(db: Pool | PoolClient, matchId: string | null = null): Promise<LegacyFootprintRow[]> {
    const { rows } = await db.query<LegacyFootprintRow>(
        `WITH match_trades AS (
             SELECT DISTINCT m.id AS match_id, m.status, m.completed_at, t.id AS trade_id
             FROM matches m
             JOIN orders o ON o.match_id = m.id
             JOIN trades t ON t.buy_order_id = o.id OR t.sell_order_id = o.id
             WHERE m.status NOT IN ('PENDING', 'ACTIVE')
               AND ($1::uuid IS NULL OR m.id = $1)
         )
         SELECT mt.match_id, mt.status, mt.completed_at::text AS completed_at,
                w.user_id, u.email, a.symbol AS asset,
                SUM(le.amount)::text AS net,
                COUNT(*)::int AS entries,
                CASE
                    WHEN a.symbol = 'USD' THEN SUM(le.amount)::text
                    ELSE (SUM(le.amount) * (
                        SELECT tp.last_price FROM trading_pairs tp
                        JOIN assets q ON q.id = tp.quote_asset_id AND q.symbol = 'USD'
                        WHERE tp.base_asset_id = a.id AND tp.last_price > 0
                        ORDER BY tp.is_active DESC LIMIT 1
                    ))::text
                END AS value_usd
         FROM match_trades mt
         JOIN trades t ON t.id = mt.trade_id
         JOIN ledger_entries le ON le.reference_id = mt.trade_id AND le.reference_type = 'TRADE'
         JOIN wallets w ON w.id = le.wallet_id AND w.competition_id IS NULL AND w.match_id IS NULL
         JOIN users u ON u.id = w.user_id
         JOIN assets a ON a.id = w.asset_id
         WHERE EXISTS (
             SELECT 1 FROM orders mo
             WHERE mo.id IN (t.buy_order_id, t.sell_order_id)
               AND mo.match_id = mt.match_id
               AND mo.user_id = w.user_id
         )
         GROUP BY mt.match_id, mt.status, mt.completed_at, w.user_id, u.email, a.id, a.symbol
         ORDER BY mt.completed_at NULLS LAST, mt.match_id, u.email, a.symbol`,
        [matchId],
    );
    return rows;
}

/** Group the rows per match and player, totalling the priced USD value. */
export function summarizeFootprint(rows: LegacyFootprintRow[]): LegacyFootprint[] {
    const out = new Map<string, LegacyFootprint>();
    for (const r of rows) {
        const key = `${r.match_id}:${r.user_id}`;
        let f = out.get(key);
        if (!f) {
            f = {
                match_id: r.match_id, status: r.status, completed_at: r.completed_at,
                user_id: r.user_id, email: r.email, assets: [], total_value_usd: "0", unpriced_assets: [],
            };
            out.set(key, f);
        }
        f.assets.push({ asset: r.asset, net: r.net, entries: r.entries, value_usd: r.value_usd });
        if (r.value_usd === null) {
            if (!D(r.net).isZero()) f.unpriced_assets.push(r.asset);
        } else {
            f.total_value_usd = D(f.total_value_usd).plus(D(r.value_usd)).toFixed(8);
        }
    }
    return [...out.values()];
}

/** Grand total of every footprint's priced value. */
export function footprintTotal(footprints: LegacyFootprint[]): string {
    return footprints.reduce((s, f) => s.plus(D(f.total_value_usd)), ZERO).toFixed(8);
}
