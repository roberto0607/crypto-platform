/**
 * Liquidation: the rule, the candidate query, the `liquidations` rows, and
 * the re-check the matching engine runs under its locks before it closes a
 * position. The engine that decides when to evaluate is liquidationEngine.ts.
 *
 * Design: docs/designs/2026-10-13-leverage-design.md §2.3 and §3.
 *
 * Rule (§3): an ISOLATED position is liquidated when its equity falls to the
 * maintenance margin, which is exactly when the mark crosses its stored
 * liq_price:
 *     long   mark <= liq_price
 *     short  mark >= liq_price
 * The mark is the mid of the Kraken book (never the ticker, never
 * trading_pairs.last_price). liq_price is recomputed from the stored margin
 * on every fill (isolatedPosition.ts), so it's right after adds and partial
 * closes.
 *
 * Exactly once per position episode: every liquidation names the position
 * `epoch` it was decided on. The matching engine re-reads the position under
 * the pair lock and again under its row lock (pair → wallets → positions)
 * and closes it only if the epoch, side and size are unchanged and the rule
 * still holds against the book read under the pair lock. Anything else (the
 * user closed or added, a trigger fired, match end settled it, another
 * engine got there first) makes it a no-op. The unique index
 * liquidations_once (migration 096) is the backstop: one row per epoch per
 * mode.
 */
import type { Pool, PoolClient } from "pg";
import Decimal from "decimal.js";
import { D, toFixed8 } from "../utils/decimal";
import { timedQuery } from "../observability/dbTiming";
import type { CollarReference } from "./priceCollar";
import type { IsolatedState } from "./isolatedPosition";
import type { PositionScope } from "./isolatedSettlement";

export type LiquidationSide = "LONG" | "SHORT";

/** What the engine asks the matching engine to close (placeOrderTx `liquidation`). */
export type LiquidationRequest = {
    /** The position episode the engine saw breach. */
    epoch: number;
    side: LiquidationSide;
};

/** A position the hot query returned (read without locks). */
export type LiquidationCandidate = {
    userId: string;
    pairId: string;
    scope: PositionScope;
    epoch: number;
    side: LiquidationSide;
    qty: Decimal;
    entry: Decimal;
    leverage: Decimal;
    margin: Decimal;
    liqPrice: Decimal;
};

/** What a liquidation booked (matchingEngine → phase6OrderService → liquidations row). */
export type LiquidationFill = {
    userId: string;
    pairId: string;
    scope: PositionScope;
    epoch: number;
    side: LiquidationSide;
    /** The position as it stood under the lock, before the close. */
    qty: string;
    entry: string;
    leverage: string;
    margin: string;
    liqPrice: string;
    mark: string;
    bookAgeMs: number;
    /** Qty-weighted average of the close's fills (the touch, or better). */
    fillPrice: string;
    /** After the loss cap. */
    realizedPnl: string;
    /** Taker fee actually collected (capped at what was left of the margin). */
    fee: string;
    /** Margin released + P&L − fee, back to the user's USD (never < 0). */
    returnedEquity: string;
    /** Loss beyond the margin (a gap past bankruptcy), absorbed. */
    shortfall: string;
};

export const sideOf = (qty: Decimal): LiquidationSide => (qty.isPositive() ? "LONG" : "SHORT");
export const closingSide = (side: LiquidationSide): "BUY" | "SELL" => (side === "LONG" ? "SELL" : "BUY");

/** The rule. A null liq price (flat, SPOT) never breaches. */
export function breaches(side: LiquidationSide, liqPrice: Decimal | null, mark: Decimal): boolean {
    if (liqPrice === null) return false;
    return side === "LONG" ? mark.lte(liqPrice) : mark.gte(liqPrice);
}

/** The mark: mid of the book reference. */
export function markOf(ref: Pick<CollarReference, "bestBid" | "bestAsk">): Decimal {
    return ref.bestBid.plus(ref.bestAsk).div(2);
}

/**
 * Why the matching engine refused to close: the position isn't the one the
 * engine saw breach, or no longer breaches. A no-op, not a failure.
 */
export class LiquidationNotNeeded extends Error {
    constructor(public readonly reason: string) {
        super("liquidation_not_needed");
    }
}

const NIL_UUID = "'00000000-0000-0000-0000-000000000000'::uuid";

// One branch per side so each is served by its own partial index from
// migration 096 (idx_positions_liq_long / idx_positions_liq_short): an index
// range scan on (pair_id, liq_price) over open ISOLATED rows only.
const CANDIDATES_SQL = `
    SELECT user_id, competition_id, match_id, epoch, base_qty::text, avg_entry_price::text,
           leverage::text, isolated_margin::text, liq_price::text
    FROM positions
    WHERE pair_id = $1 AND margin_mode = 'ISOLATED' AND base_qty > 0 AND liq_price >= $2
    UNION ALL
    SELECT user_id, competition_id, match_id, epoch, base_qty::text, avg_entry_price::text,
           leverage::text, isolated_margin::text, liq_price::text
    FROM positions
    WHERE pair_id = $1 AND margin_mode = 'ISOLATED' AND base_qty < 0 AND liq_price <= $2`;

export const LIQUIDATION_CANDIDATES_SQL = CANDIDATES_SQL;

/** The hot query: every open ISOLATED position on `pairId` that breaches at `mark`. */
export async function findLiquidationCandidates(
    db: Pool | PoolClient, pairId: string, mark: Decimal,
): Promise<LiquidationCandidate[]> {
    const { rows } = await timedQuery<{
        user_id: string; competition_id: string | null; match_id: string | null; epoch: number;
        base_qty: string; avg_entry_price: string; leverage: string; isolated_margin: string; liq_price: string;
    }>(db, "liquidation.candidates", CANDIDATES_SQL, [pairId, toFixed8(mark)]);
    return rows.map((r) => {
        const qty = D(r.base_qty);
        return {
            userId: r.user_id,
            pairId,
            scope: { competitionId: r.competition_id, matchId: r.match_id },
            epoch: r.epoch,
            side: sideOf(qty),
            qty: qty.abs(),
            entry: D(r.avg_entry_price),
            leverage: D(r.leverage),
            margin: D(r.isolated_margin),
            liqPrice: D(r.liq_price),
        };
    });
}

/** An open ISOLATED position near its liq price (the margin-warning scan). */
export type MarginWatchRow = LiquidationCandidate & { mmrBps: number };

/**
 * Every open ISOLATED position on `pairId` whose margin health at `mark` is
 * below `health`. Health is linear in the mark (1 at entry, 0 at the liq
 * price), so that's the mark being past W = liq + health·(entry − liq): at or
 * below W for a long, at or above it for a short.
 */
export async function findMarginWatch(
    db: Pool | PoolClient, pairId: string, mark: Decimal, health: number,
): Promise<MarginWatchRow[]> {
    const { rows } = await timedQuery<{
        user_id: string; competition_id: string | null; match_id: string | null; epoch: number;
        base_qty: string; avg_entry_price: string; leverage: string; isolated_margin: string; liq_price: string;
        maintenance_margin_bps: number;
    }>(db, "liquidation.marginWatch",
        `SELECT p.user_id, p.competition_id, p.match_id, p.epoch, p.base_qty::text, p.avg_entry_price::text,
                p.leverage::text, p.isolated_margin::text, p.liq_price::text, tp.maintenance_margin_bps
         FROM positions p
         JOIN trading_pairs tp ON tp.id = p.pair_id
         WHERE p.pair_id = $1 AND p.margin_mode = 'ISOLATED' AND p.liq_price IS NOT NULL
           AND ((p.base_qty > 0 AND p.liq_price + $3::numeric * (p.avg_entry_price - p.liq_price) >= $2)
             OR (p.base_qty < 0 AND p.liq_price + $3::numeric * (p.avg_entry_price - p.liq_price) <= $2))`,
        [pairId, toFixed8(mark), String(health)]);
    return rows.map((r) => {
        const qty = D(r.base_qty);
        return {
            userId: r.user_id,
            pairId,
            scope: { competitionId: r.competition_id, matchId: r.match_id },
            epoch: r.epoch,
            side: sideOf(qty),
            qty: qty.abs(),
            entry: D(r.avg_entry_price),
            leverage: D(r.leverage),
            margin: D(r.isolated_margin),
            liqPrice: D(r.liq_price),
            mmrBps: r.maintenance_margin_bps,
        };
    });
}

/**
 * Record a breach the engine did not act on: LOG_ONLY (log-only mode) or
 * SKIPPED_STALE (the pair's feed was stale). One statement: the row is built
 * from the position as it is now, and only if it's still the same episode
 * and still breaches at `mark`. At most one row per epoch per mode
 * (liquidations_once); returns null when nothing was written. Never touches
 * positions or wallets.
 */
export async function recordUnexecutedTx(
    db: Pool | PoolClient,
    mode: "LOG_ONLY" | "SKIPPED_STALE",
    c: Pick<LiquidationCandidate, "userId" | "pairId" | "scope" | "epoch">,
    mark: Decimal,
    bookAgeMs: number | null,
): Promise<{ id: string; qty: string; entry: string; leverage: string; margin: string; liqPrice: string } | null> {
    const { rows } = await timedQuery<{
        id: string; qty: string; entry_price: string; leverage: string; margin: string; liq_price: string;
    }>(db, "liquidation.recordUnexecuted",
        `INSERT INTO liquidations (mode, user_id, pair_id, competition_id, match_id, position_epoch, side,
                                   qty, entry_price, leverage, margin, liq_price, mark_price, book_age_ms)
         SELECT $1, user_id, pair_id, competition_id, match_id, epoch,
                CASE WHEN base_qty > 0 THEN 'LONG' ELSE 'SHORT' END,
                abs(base_qty), avg_entry_price, leverage, isolated_margin, liq_price, $7, $8
         FROM positions
         WHERE user_id = $2 AND pair_id = $3
           AND COALESCE(competition_id, ${NIL_UUID}) = COALESCE($4::uuid, ${NIL_UUID})
           AND COALESCE(match_id, ${NIL_UUID}) = COALESCE($5::uuid, ${NIL_UUID})
           AND margin_mode = 'ISOLATED' AND epoch = $6
           AND ((base_qty > 0 AND liq_price >= $7) OR (base_qty < 0 AND liq_price <= $7))
         ON CONFLICT DO NOTHING
         RETURNING id, qty::text, entry_price::text, leverage::text, margin::text, liq_price::text`,
        [mode, c.userId, c.pairId, c.scope.competitionId, c.scope.matchId, c.epoch, toFixed8(mark), bookAgeMs],
    );
    const r = rows[0];
    return r ? { id: r.id, qty: r.qty, entry: r.entry_price, leverage: r.leverage, margin: r.margin, liqPrice: r.liq_price } : null;
}

/** The EXECUTED row, in the liquidation order's own transaction. */
export async function recordExecutedTx(client: PoolClient, f: LiquidationFill, orderId: string): Promise<string> {
    const { rows } = await timedQuery<{ id: string }>(client, "liquidation.recordExecuted",
        `INSERT INTO liquidations (mode, user_id, pair_id, competition_id, match_id, position_epoch, side,
                                   qty, entry_price, leverage, margin, liq_price, mark_price, fill_price,
                                   realized_pnl, fee, returned_equity, shortfall, book_age_ms, order_id)
         VALUES ('EXECUTED', $1, $2, $3::uuid, $4::uuid, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
         RETURNING id`,
        [f.userId, f.pairId, f.scope.competitionId, f.scope.matchId, f.epoch, f.side,
            f.qty, f.entry, f.leverage, f.margin, f.liqPrice, f.mark, f.fillPrice,
            f.realizedPnl, f.fee, f.returnedEquity, f.shortfall, f.bookAgeMs, orderId],
    );
    return rows[0].id;
}

/**
 * The matching engine's check, under the pair lock and again under the
 * position row lock: is this still the episode the engine saw, on the same
 * side, and does it still breach against the book read under the pair lock?
 * Throws LiquidationNotNeeded otherwise. Returns the size to close: the
 * position's current size, never the engine's stale candidate size.
 */
export function confirmLiquidation(
    position: IsolatedState,
    mode: "SPOT" | "ISOLATED",
    request: LiquidationRequest,
    mark: Decimal,
): Decimal {
    if (mode !== "ISOLATED") throw new LiquidationNotNeeded("not_isolated");
    if (position.qty.isZero()) throw new LiquidationNotNeeded("flat");
    if (position.epoch !== request.epoch) throw new LiquidationNotNeeded("epoch_changed");
    if (sideOf(position.qty) !== request.side) throw new LiquidationNotNeeded("side_changed");
    if (!breaches(request.side, position.liqPrice, mark)) throw new LiquidationNotNeeded("no_breach");
    return position.qty.abs();
}
