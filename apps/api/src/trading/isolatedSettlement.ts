/**
 * The ISOLATED (perp-style) leg of a fill: which model an order trades under,
 * and how one fill settles into the user's position and USD wallet.
 *
 * Design: docs/designs/2026-10-13-leverage-design.md §1 (Option B) and §2.2.
 *
 * A real user's order in an ISOLATED scope never moves base. The USD wallet
 * is the only balance and the position row is the instrument:
 *   open/add   MARGIN_LOCK (−margin) and FEE (−fee) out of USD
 *   reduce     MARGIN_RELEASE (+released), REALIZED_PNL (±), FEE (−), with
 *              the loss capped at the released margin; a loss beyond it (a
 *              price gap) is absorbed and recorded as LIQUIDATION_SHORTFALL
 *              (amount 0, the shortfall in metadata). USD never goes
 *              negative because of a position.
 *
 * Bots and @system.local users always trade SPOT (the existing path in
 * matchingEngine.ts), so in a fill between a user and the market maker each
 * leg settles in its own model.
 *
 * Lock order: the caller holds the pair lock and the wallet locks; the
 * position row is locked here, last (pair → wallets → positions).
 */
import type { PoolClient } from "pg";
import Decimal from "decimal.js";
import { D, ZERO, toFixed8 } from "../utils/decimal";
import { timedQuery } from "../observability/dbTiming";
import { config } from "../config";
import { isSystemUser } from "./buyingPower";
import { leverageCap, type LeverageMode } from "./leverageConfig";
import { applyIsolatedFill, FLAT, type IsolatedState } from "./isolatedPosition";
import { debitAvailableTx } from "../wallets/walletRepo";

export type MarginMode = "SPOT" | "ISOLATED";
export type PositionScope = { competitionId: string | null; matchId: string | null };

const NIL_UUID = "'00000000-0000-0000-0000-000000000000'::uuid";
const SCOPE_SQL = (first: number) =>
    `COALESCE(competition_id, ${NIL_UUID}) = COALESCE($${first}::uuid, ${NIL_UUID})
     AND COALESCE(match_id, ${NIL_UUID}) = COALESCE($${first + 1}::uuid, ${NIL_UUID})`;

type PositionDbRow = {
    base_qty: string;
    avg_entry_price: string;
    margin_mode: MarginMode;
    leverage: string;
    isolated_margin: string;
    liq_price: string | null;
    epoch: number;
};

const POSITION_READ = `base_qty::text, avg_entry_price::text, margin_mode, leverage::text,
                       isolated_margin::text, liq_price::text, epoch`;

async function readPosition(
    client: PoolClient, userId: string, pairId: string, scope: PositionScope, forUpdate: boolean,
): Promise<PositionDbRow | null> {
    const { rows } = await timedQuery<PositionDbRow>(client,
        forUpdate ? "isolatedSettlement.lockPosition" : "isolatedSettlement.readPosition",
        `SELECT ${POSITION_READ} FROM positions
         WHERE user_id = $1 AND pair_id = $2 AND ${SCOPE_SQL(3)}
         ${forUpdate ? "FOR UPDATE" : ""}`,
        [userId, pairId, scope.competitionId, scope.matchId],
    );
    return rows[0] ?? null;
}

function stateOf(row: PositionDbRow | null): IsolatedState {
    if (!row || D(row.base_qty).isZero()) {
        return { ...FLAT, epoch: row?.epoch ?? 0 };
    }
    return {
        qty: D(row.base_qty),
        entry: D(row.avg_entry_price),
        margin: D(row.isolated_margin),
        leverage: D(row.leverage),
        epoch: row.epoch,
        liqPrice: row.liq_price === null ? null : D(row.liq_price),
    };
}

/** Per-pair risk parameters (migration 096; SOL's 100 bps set by 097). */
export async function pairRiskParams(client: PoolClient, pairId: string): Promise<{ mmrBps: number; maxLeverage: number }> {
    const { rows } = await timedQuery<{ maintenance_margin_bps: number; max_leverage: string }>(client,
        "isolatedSettlement.pairRiskParams",
        `SELECT maintenance_margin_bps, max_leverage::text FROM trading_pairs WHERE id = $1`,
        [pairId],
    );
    if (!rows[0]) throw new Error("pair_not_found");
    return { mmrBps: rows[0].maintenance_margin_bps, maxLeverage: Number(rows[0].max_leverage) };
}

export type TakerMargin =
    | { mode: "SPOT" }
    | {
        mode: "ISOLATED";
        /** The position as it stands (read under the pair lock). */
        position: IsolatedState;
        mmrBps: number;
        /** Highest leverage this order may open at. */
        cap: number;
        /**
         * The leverage already in force on this pair/scope: the open
         * position's, else that of the user's resting ISOLATED orders. One
         * leverage per (user, pair, scope) while anything is open.
         */
        inherited: Decimal | null;
    };

/**
 * Which model `userId`'s order on `pairId` in `scope` trades under.
 *
 *   1. An open position keeps its model (a SPOT position opened before
 *      leverage keeps trading spot until it's flat; an ISOLATED one stays
 *      ISOLATED even if the flag is later turned off).
 *   2. Otherwise SPOT when LEVERAGE_ENABLED is off, for system users, and in
 *      a match stamped SPOT (every match until PR 3 stamps them at accept).
 *   3. Otherwise ISOLATED.
 *
 * A resting order of the other model on the same pair/scope blocks the order
 * (`spot_orders_open` / `isolated_orders_open`): its fill would land on a
 * position of the wrong model.
 */
export async function resolveTakerMargin(
    client: PoolClient,
    params: { userId: string; pairId: string; scope: PositionScope; replay: boolean },
): Promise<TakerMargin> {
    const { userId, pairId, scope } = params;
    const cfg = config.leverage;

    if (await isSystemUser(userId, client)) return { mode: "SPOT" };

    const row = await readPosition(client, userId, pairId, scope, false);
    const open = row !== null && !D(row.base_qty).isZero();

    let mode: MarginMode;
    let matchCap: number | null = null;
    if (open) {
        mode = row!.margin_mode;
    } else if (!cfg.enabled) {
        mode = "SPOT";
    } else if (scope.matchId) {
        const { rows } = await timedQuery<{ margin_mode: MarginMode; max_leverage: string }>(client,
            "isolatedSettlement.matchMarginMode",
            `SELECT margin_mode, max_leverage::text FROM matches WHERE id = $1`,
            [scope.matchId],
        );
        mode = rows[0]?.margin_mode ?? "SPOT";
        matchCap = rows[0] ? Number(rows[0].max_leverage) : null;
    } else {
        mode = "ISOLATED";
    }

    const other: MarginMode = mode === "SPOT" ? "ISOLATED" : "SPOT";
    const { rows: resting } = await timedQuery<{ margin_mode: MarginMode; leverage: string }>(client,
        "isolatedSettlement.restingOrders",
        `SELECT DISTINCT margin_mode, leverage::text FROM orders
         WHERE user_id = $1 AND pair_id = $2 AND status IN ('OPEN', 'PARTIALLY_FILLED')
           AND ${SCOPE_SQL(3)}`,
        [userId, pairId, scope.competitionId, scope.matchId],
    );
    if (resting.some((r) => r.margin_mode === other)) {
        throw new Error(mode === "ISOLATED" ? "spot_orders_open" : "isolated_orders_open");
    }
    if (mode === "SPOT") return { mode };

    if (scope.matchId && matchCap === null) {
        const { rows } = await timedQuery<{ max_leverage: string }>(client,
            "isolatedSettlement.matchCap",
            `SELECT max_leverage::text FROM matches WHERE id = $1`,
            [scope.matchId],
        );
        matchCap = rows[0] ? Number(rows[0].max_leverage) : 1;
    }

    const { mmrBps, maxLeverage } = await pairRiskParams(client, pairId);
    const leverageMode: LeverageMode = scope.matchId ? "MATCH" : scope.competitionId ? "COMPETITION" : "FREE_PLAY";
    // Solo replay prices off historical candles, not the live book: 1x (§2.3).
    const cap = params.replay ? 1 : leverageCap(cfg, {
        mode: leverageMode, userId, pairMaxLeverage: maxLeverage, matchMaxLeverage: matchCap,
    });

    const position = stateOf(row);
    const inherited = !position.qty.isZero()
        ? position.leverage
        : resting.length > 0 ? D(resting[0].leverage) : null;

    return { mode: "ISOLATED", position, mmrBps, cap, inherited };
}

/** Lock the position row (creating it if missing) and return its state. */
export async function lockIsolatedPositionTx(
    client: PoolClient, userId: string, pairId: string, scope: PositionScope,
): Promise<{ state: IsolatedState; mode: MarginMode }> {
    await timedQuery(client, "isolatedSettlement.upsertPosition",
        `INSERT INTO positions (user_id, pair_id, competition_id, match_id)
         VALUES ($1, $2, $3::uuid, $4::uuid)
         ON CONFLICT (user_id, pair_id,
                      COALESCE(competition_id, ${NIL_UUID}),
                      COALESCE(match_id, ${NIL_UUID}))
         DO NOTHING`,
        [userId, pairId, scope.competitionId, scope.matchId],
    );
    const row = (await readPosition(client, userId, pairId, scope, true))!;
    return { state: stateOf(row), mode: row.margin_mode };
}

export type IsolatedLeg = {
    userId: string;
    /** Signed size after the fill (for the trigger-cancel hook). */
    baseQtyAfter: string;
    /** Fee actually charged for this fill (capped on a loss-capped reduce). */
    feeBooked: string;
};

type LedgerMeta = Record<string, unknown>;

async function postUsd(
    client: PoolClient,
    walletId: string,
    amount: Decimal,
    entryType: string,
    tradeId: string,
    metadata: LedgerMeta,
    fromReserve = ZERO,
): Promise<void> {
    const { rows } = await timedQuery<{ balance: string }>(client, "isolatedSettlement.postUsd",
        `UPDATE wallets SET balance = balance + $1, reserved = reserved - $2
         WHERE id = $3 RETURNING balance::text`,
        [toFixed8(amount), toFixed8(fromReserve), walletId],
    );
    if (!rows[0]) throw new Error("wallet_not_found");
    await timedQuery(client, "isolatedSettlement.ledger",
        `INSERT INTO ledger_entries (wallet_id, entry_type, amount, balance_after, reference_id, reference_type, metadata)
         VALUES ($1, $2, $3, $4, $5, 'TRADE', $6::jsonb)`,
        [walletId, entryType, toFixed8(amount), rows[0].balance, tradeId, JSON.stringify(metadata)],
    );
}

/**
 * Settle one fill's ISOLATED leg: update the position and move USD.
 *
 * `reserve` is what's left of the order's LIMIT reserve (a resting maker
 * order's margin + max fee). Opening debits are drawn from it first; with no
 * reserve they must fit the wallet's free balance (`insufficient_balance`
 * otherwise; the engine checks this up front, so it's a backstop).
 *
 * Returns the leg for the post-fill pipeline and how much reserve it used.
 */
export async function settleIsolatedFillTx(
    client: PoolClient,
    p: {
        userId: string;
        pairId: string;
        scope: PositionScope;
        side: "BUY" | "SELL";
        qty: string;
        price: string;
        fee: string;
        feeRole: "TAKER" | "MAKER";
        /** The order's leverage (used when the fill opens from flat). */
        leverage: Decimal;
        mmrBps: number;
        usdWalletId: string;
        tradeId: string;
        ts: number;
        reserve?: Decimal;
    },
): Promise<{ leg: IsolatedLeg; reserveUsed: Decimal }> {
    const { state, mode } = await lockIsolatedPositionTx(client, p.userId, p.pairId, p.scope);
    if (mode === "SPOT" && !state.qty.isZero()) throw new Error("position_mode_conflict");

    const r = applyIsolatedFill(state, p.side, D(p.qty), D(p.price), D(p.fee), p.leverage, p.mmrBps);
    const meta: LedgerMeta = { pairId: p.pairId, feeRole: p.feeRole, epoch: r.next.epoch };

    let bookedPnl = ZERO;
    let feeBooked = ZERO;
    let reserveLeft = p.reserve ?? ZERO;
    let reserveUsed = ZERO;

    if (r.reduce) {
        const s = r.reduce.settlement;
        bookedPnl = s.bookedPnl;
        feeBooked = feeBooked.plus(s.bookedFee);
        // Release first, so the P&L debit and fee are always covered by it.
        if (r.reduce.released.gt(0)) {
            await postUsd(client, p.usdWalletId, r.reduce.released, "MARGIN_RELEASE", p.tradeId, meta);
        }
        if (!s.bookedPnl.isZero()) {
            await postUsd(client, p.usdWalletId, s.bookedPnl, "REALIZED_PNL", p.tradeId, meta);
        }
        if (s.bookedFee.gt(0)) {
            await postUsd(client, p.usdWalletId, s.bookedFee.neg(), "FEE", p.tradeId,
                { ...meta, ...(s.uncollectedFee.gt(0) ? { uncollectedFee: toFixed8(s.uncollectedFee) } : {}) });
        }
        if (s.shortfall.gt(0)) {
            await postUsd(client, p.usdWalletId, ZERO, "LIQUIDATION_SHORTFALL", p.tradeId, {
                ...meta,
                shortfall: toFixed8(s.shortfall),
                uncollectedFee: toFixed8(s.uncollectedFee),
            });
        }
    }

    if (r.open) {
        feeBooked = feeBooked.plus(r.open.fee);
        for (const [amount, type] of [[r.open.margin, "MARGIN_LOCK"], [r.open.fee, "FEE"]] as const) {
            if (amount.isZero()) continue;
            if (p.reserve !== undefined) {
                const fromReserve = Decimal.min(amount, reserveLeft);
                reserveLeft = reserveLeft.minus(fromReserve);
                reserveUsed = reserveUsed.plus(fromReserve);
                await postUsd(client, p.usdWalletId, amount.neg(), type, p.tradeId,
                    { ...meta, leverage: r.next.leverage.toString() }, fromReserve);
            } else {
                await debitAvailableTx(client, p.usdWalletId, toFixed8(amount), type, p.tradeId, "TRADE",
                    { ...meta, leverage: r.next.leverage.toString() });
            }
        }
    }

    const n = r.next;
    const { rows } = await timedQuery<{ base_qty: string; realized_pnl_quote: string; fees_paid_quote: string }>(client,
        "isolatedSettlement.updatePosition",
        `UPDATE positions
         SET base_qty = $5,
             avg_entry_price = $6,
             realized_pnl_quote = realized_pnl_quote + $7,
             fees_paid_quote = fees_paid_quote + $8,
             margin_mode = 'ISOLATED',
             leverage = $9,
             isolated_margin = $10,
             liq_price = $11,
             epoch = $12,
             opened_at = CASE WHEN $13::boolean THEN now()
                              WHEN $5::numeric = 0 THEN NULL
                              ELSE opened_at END
         WHERE user_id = $1 AND pair_id = $2 AND ${SCOPE_SQL(3)}
         RETURNING base_qty::text, realized_pnl_quote::text, fees_paid_quote::text`,
        [
            p.userId, p.pairId, p.scope.competitionId, p.scope.matchId,
            toFixed8(n.qty), toFixed8(n.entry), toFixed8(bookedPnl), toFixed8(feeBooked),
            n.leverage.toFixed(2), toFixed8(n.margin), n.liqPrice === null ? null : toFixed8(n.liqPrice),
            n.epoch, r.openedFromFlat,
        ],
    );

    // Same narrow equity snapshot applyFillToPositionTx writes (realized − fees).
    const pos = rows[0];
    await timedQuery(client, "isolatedSettlement.equitySnapshot",
        `INSERT INTO equity_snapshots (user_id, ts, equity_quote, competition_id, match_id)
         VALUES ($1, $2, $3, $4::uuid, $5::uuid)
         ON CONFLICT (user_id, ts,
                      COALESCE(competition_id, ${NIL_UUID}),
                      COALESCE(match_id, ${NIL_UUID}))
         DO UPDATE SET equity_quote = $3`,
        [p.userId, p.ts, toFixed8(D(pos.realized_pnl_quote).minus(D(pos.fees_paid_quote))), p.scope.competitionId, p.scope.matchId],
    );

    return {
        leg: { userId: p.userId, baseQtyAfter: pos.base_qty, feeBooked: toFixed8(feeBooked) },
        reserveUsed,
    };
}

/**
 * The margin + fee an ISOLATED order's immediate fills would take out of USD,
 * walked fill by fill against the position (the same math the settlement
 * uses). Reducing parts need nothing. Also returns the position after them
 * and whether any part opens or adds.
 */
export function isolatedOpenCost(
    position: IsolatedState,
    side: "BUY" | "SELL",
    fills: { qty: Decimal; price: Decimal; fee: Decimal }[],
    leverage: Decimal,
    mmrBps: number,
): { cost: Decimal; opensQty: Decimal; after: IsolatedState } {
    let state = position;
    let cost = ZERO;
    let opensQty = ZERO;
    for (const f of fills) {
        const r = applyIsolatedFill(state, side, f.qty, f.price, f.fee, leverage, mmrBps);
        if (r.open) {
            cost = cost.plus(r.open.margin).plus(r.open.fee);
            opensQty = opensQty.plus(r.open.qty);
        }
        state = r.next;
    }
    return { cost, opensQty, after: state };
}
