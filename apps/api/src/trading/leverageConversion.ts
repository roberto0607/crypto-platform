/**
 * The one-time conversion of open SPOT positions into 1x ISOLATED positions
 * (leverage PR 5). The CLI is scripts/convertToIsolated.ts
 * (`pnpm leverage:convert`); the runbook is docs/runbooks/leverage-convert.md.
 *
 * Design: docs/designs/2026-10-13-leverage-design.md §1 ("How 1x coexists
 * and migrates under B") and §6 (Phase 1, step 2).
 *
 * What converts: every open SPOT position of a real user in free-play or a
 * competition. Never a match position (a match keeps the model stamped at
 * accept until it ends), never a bot or @system.local user, never a row
 * that's already ISOLATED or flat.
 *
 * How, per position of signed size q at avg entry P (M = |q|·P, 8 dp):
 *   1. resting SPOT orders of the user on that pair and scope are canceled
 *      (their fill would land on a position of the wrong model): holds
 *      released, cancel_reason 'leverage_conversion', ORDER_CANCELLED outbox
 *   2. base wallet −q (POSITION_CONVERSION): the position's base leaves it
 *   3. USD ±M (POSITION_CONVERSION): that base settled at P, the same price
 *      the position opens at (long +M, short −M: the buy-back)
 *   4. USD −M (MARGIN_LOCK): the margin of a 1x position
 *   5. the row becomes ISOLATED: leverage 1, isolated_margin M, liq price
 *      from margin.ts, epoch + 1 (a new episode), opened_at now. Entry,
 *      size, realized P&L and fees are unchanged.
 * A long's USD nets to 0; a short's falls by 2M.
 *
 * Equity is unchanged at any mark m, by both measures:
 *   app (getPortfolioSummary)  USD + Σ positionValue: q·m before;
 *                              after Δusd + M + q(m − P) = q·m
 *   wallets                    USD + base·m: base·m before; after
 *                              Δusd + (base − q)·m + M + q(m − P) = base·m
 * (to < 1e-8, the rounding of M). It holds while the loss cap doesn't bind:
 * a long at 1x never does; a short does only past 2P, so a short whose 1x
 * liq price is already at or below the mark is blocked instead.
 *
 * Only the position's own qty leaves the base wallet. If the wallet holds
 * more or less than the position (old drift, e.g. pre-#207 match fills on
 * the free-play wallet), the difference stays in the wallet and is
 * reported as `residue`; it was never part of the position. (§1 suggested
 * striking a drifted position at the mark instead; converting exactly q at
 * P keeps equity identical by both measures without needing a mark.)
 *
 * Blocked (that user is left as is and reported): `insufficient_usd` (a
 * short's 2M doesn't fit the USD free after the cancels), `short_past_liq`,
 * `no_mark` (a short on a pair with no last price to check that against),
 * `wallet_missing`.
 *
 * Safety: each user converts in its own transaction, under the locks
 * trading takes, in trading's order: the pairs (sorted) → the user's
 * wallets in those scopes (sorted) → the position rows. The plan is
 * recomputed from the rows read under those locks, so an order or fill
 * that got there first is converted as it left the position. Before
 * COMMIT the scope's equity is recomputed from the database and compared
 * with the plan's; any difference rolls the user back (`equity_mismatch`).
 * The dry run computes the same plan in a READ ONLY transaction.
 */
import type { PoolClient } from "pg";
import Decimal from "decimal.js";
import { pool } from "../db/pool";
import { D, ZERO, toFixed8 } from "../utils/decimal";
import { timedQuery } from "../observability/dbTiming";
import { createEvent } from "../events/eventTypes";
import type { AppEvent } from "../events/eventTypes";
import { publish } from "../events/eventBus";
import { insertOutboxEventTx } from "../outbox/outboxRepo";
import {
    creditWalletTx,
    debitAvailableTx,
    debitUnconstrainedTx,
    walletUpdatedEventsTx,
} from "../wallets/walletRepo";
import { positionValue } from "../analytics/accountEquity";
import { isSystemUser } from "./buyingPower";
import { cancelOrderTx } from "./matchingEngine";
import { liquidationPrice } from "./margin";

export const CONVERSION_CANCEL_REASON = "leverage_conversion";
const ENTRY_TYPE = "POSITION_CONVERSION";

/** Below this, two equity figures are the same (the 8 dp rounding of M). */
const EQUITY_TOLERANCE = D("0.00000001");

const dp8 = (d: Decimal) => d.toDecimalPlaces(8, Decimal.ROUND_DOWN);

// ── The math (pure) ─────────────────────────────────────────────────────

export type ConvertedPosition = {
    side: "LONG" | "SHORT";
    /** |q|·P: the 1x margin. */
    margin: Decimal;
    liqPrice: Decimal;
    /** −q: what leaves the base wallet. */
    baseDelta: Decimal;
    /** The base settled at the entry: +M long, −M short. */
    usdSettle: Decimal;
    /** usdSettle − M: 0 for a long, −2M for a short. */
    usdDelta: Decimal;
};

/** A SPOT position of signed size `qty` at `entry` as a 1x ISOLATED one. */
export function convertedPosition(p: { qty: Decimal; entry: Decimal; mmrBps: number }): ConvertedPosition {
    const side = p.qty.isPositive() ? "LONG" : "SHORT";
    const size = p.qty.abs();
    const margin = dp8(size.mul(p.entry));
    const liqPrice = dp8(liquidationPrice({ side, qty: size, entry: p.entry, margin, mmrBps: p.mmrBps }));
    const usdSettle = side === "LONG" ? margin : margin.neg();
    return { side, margin, liqPrice, baseDelta: p.qty.neg(), usdSettle, usdDelta: usdSettle.minus(margin) };
}

// ── Plans ───────────────────────────────────────────────────────────────

export type PositionPlan = {
    pairId: string;
    symbol: string;
    side: "LONG" | "SHORT";
    /** Signed. */
    qty: string;
    entry: string;
    leverage: string;
    margin: string;
    liqPrice: string;
    /** trading_pairs.last_price, for the report and the short check. */
    mark: string | null;
    epochAfter: number;
    baseWalletId: string;
    baseBefore: string;
    baseAfter: string;
    /** baseBefore − qty: what stays in the base wallet (drift). */
    residue: string;
};

export type CancelPlan = {
    orderId: string;
    pairId: string;
    symbol: string;
    side: string;
    type: string;
    remaining: string;
    limitPrice: string | null;
    releasedAmount: string;
    releasedWalletId: string | null;
};

export type LedgerLine = { walletId: string; asset: string; entryType: string; amount: string; pairId: string };

export type ScopePlan = {
    /** null = free-play. */
    competitionId: string | null;
    usd: { walletId: string; balanceBefore: string; balanceAfter: string; reservedBefore: string; reservedAfter: string };
    /** App equity (USD + Σ positionValue at last_price); null if a pair has no last price. */
    equityBefore: string | null;
    equityAfter: string | null;
    positions: PositionPlan[];
    cancels: CancelPlan[];
    ledger: LedgerLine[];
    /** Resting SPOT orders of this scope on pairs that aren't converted: left as they are. */
    otherSpotOrders: number;
};

export type UserPlan = {
    userId: string;
    email: string;
    blocked: null | { reason: string; detail: string };
    scopes: ScopePlan[];
};

type PositionRow = {
    pair_id: string; competition_id: string | null; base_qty: string; avg_entry_price: string; margin_mode: string;
    isolated_margin: string; epoch: number; symbol: string; base_asset_id: string; quote_asset_id: string;
    last_price: string | null; maintenance_margin_bps: number;
};
type WalletRow = { id: string; asset_id: string; competition_id: string | null; balance: string; reserved: string; symbol: string };
type OrderRow = {
    id: string; pair_id: string; competition_id: string | null; side: string; type: string; remaining: string;
    limit_price: string | null; releasable: string; reserved_wallet_id: string | null; symbol: string;
};

const scopeKey = (competitionId: string | null) => competitionId ?? "";

/** The SPOT positions a user has to convert: (pair, competition) of each open non-match SPOT row. */
async function spotCandidates(db: PoolClient, userId: string): Promise<{ pairId: string; competitionId: string | null }[]> {
    const { rows } = await timedQuery<{ pair_id: string; competition_id: string | null }>(db, "leverageConversion.candidates",
        `SELECT pair_id, competition_id FROM positions
         WHERE user_id = $1 AND match_id IS NULL AND margin_mode = 'SPOT' AND base_qty <> 0
         ORDER BY pair_id`,
        [userId],
    );
    return rows.map((r) => ({ pairId: r.pair_id, competitionId: r.competition_id }));
}

/**
 * Read the user's state in the scopes that have something to convert and
 * build the plan. With `lock`, takes trading's locks first, in its order.
 * Returns null when there's nothing to convert (any more).
 */
async function buildPlanTx(client: PoolClient, userId: string, lock: boolean): Promise<UserPlan | null> {
    const candidates = await spotCandidates(client, userId);
    if (candidates.length === 0) return null;

    const pairIds = [...new Set(candidates.map((c) => c.pairId))].sort();
    const competitionIds = [...new Set(candidates.map((c) => c.competitionId))];
    const compParams = competitionIds.map((c) => c ?? "00000000-0000-0000-0000-000000000000");
    const inScopes = (col: string) =>
        `COALESCE(${col}, '00000000-0000-0000-0000-000000000000'::uuid) = ANY($2::uuid[])`;

    // 1. Pairs, sorted (the matching engine's Level 1).
    if (lock) {
        await timedQuery(client, "leverageConversion.lockPairs",
            `SELECT id FROM trading_pairs WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`, [pairIds]);
    }

    // 2. Every wallet of the user in those scopes, sorted (Level 2).
    const { rows: wallets } = await timedQuery<WalletRow>(client, "leverageConversion.wallets",
        `SELECT w.id, w.asset_id, w.competition_id, w.balance::text, w.reserved::text, a.symbol
         FROM wallets w JOIN assets a ON a.id = w.asset_id
         WHERE w.user_id = $1 AND w.match_id IS NULL AND ${inScopes("w.competition_id")}
         ORDER BY w.id ${lock ? "FOR UPDATE OF w" : ""}`,
        [userId, compParams],
    );

    // 3. Position rows of those scopes (the converted pairs' rows locked, last).
    if (lock) {
        await timedQuery(client, "leverageConversion.lockPositions",
            `SELECT 1 FROM positions
             WHERE user_id = $1 AND match_id IS NULL AND ${inScopes("competition_id")} AND pair_id = ANY($3::uuid[])
             ORDER BY pair_id, competition_id FOR UPDATE`,
            [userId, compParams, pairIds],
        );
    }
    const { rows: positions } = await timedQuery<PositionRow>(client, "leverageConversion.positions",
        `SELECT p.pair_id, p.competition_id, p.base_qty::text, p.avg_entry_price::text, p.margin_mode,
                p.isolated_margin::text, p.epoch, tp.symbol, tp.base_asset_id, tp.quote_asset_id,
                tp.last_price::text, tp.maintenance_margin_bps
         FROM positions p JOIN trading_pairs tp ON tp.id = p.pair_id
         WHERE p.user_id = $1 AND p.match_id IS NULL AND ${inScopes("p.competition_id")}
         ORDER BY tp.symbol, p.competition_id`,
        [userId, compParams],
    );

    // What's left to convert, as read under the locks (an order may have
    // closed or changed a position since the candidate read).
    const toConvert = positions.filter((p) =>
        p.margin_mode === "SPOT" && !D(p.base_qty).isZero() && pairIds.includes(p.pair_id));
    if (toConvert.length === 0) return null;

    const { rows: orders } = await timedQuery<OrderRow>(client, "leverageConversion.spotOrders",
        `SELECT o.id, o.pair_id, o.competition_id, o.side, o.type, (o.qty - o.qty_filled)::text AS remaining,
                o.limit_price::text, (o.reserved_amount - o.reserved_consumed)::text AS releasable,
                o.reserved_wallet_id, tp.symbol
         FROM orders o JOIN trading_pairs tp ON tp.id = o.pair_id
         WHERE o.user_id = $1 AND o.match_id IS NULL AND ${inScopes("o.competition_id")}
           AND o.status IN ('OPEN', 'PARTIALLY_FILLED') AND o.margin_mode = 'SPOT'
         ORDER BY o.created_at, o.id`,
        [userId, compParams],
    );

    const { rows: [user] } = await timedQuery<{ email: string }>(client, "leverageConversion.user",
        `SELECT email FROM users WHERE id = $1`, [userId]);

    const plan: UserPlan = { userId, email: user?.email ?? "", blocked: null, scopes: [] };
    const block = (reason: string, detail: string) => { if (!plan.blocked) plan.blocked = { reason, detail }; };

    for (const competitionId of competitionIds.sort((a, b) => scopeKey(a).localeCompare(scopeKey(b)))) {
        const key = scopeKey(competitionId);
        const scopeWallets = wallets.filter((w) => scopeKey(w.competition_id) === key);
        const walletOf = (assetId: string) => scopeWallets.find((w) => w.asset_id === assetId) ?? null;
        const scopePositions = positions.filter((p) => scopeKey(p.competition_id) === key);
        const converting = toConvert.filter((p) => scopeKey(p.competition_id) === key);
        if (converting.length === 0) continue;
        const convertingPairs = new Set(converting.map((p) => p.pair_id));

        // One quote asset (USD) across the converted pairs.
        const quoteAssetId = converting[0].quote_asset_id;
        const usd = walletOf(quoteAssetId);
        if (!usd || converting.some((p) => p.quote_asset_id !== quoteAssetId)) {
            block("wallet_missing", `no single quote wallet in scope ${competitionId ?? "free-play"}`);
            continue;
        }

        const scopeOrders = orders.filter((o) => scopeKey(o.competition_id) === key);
        const cancels: CancelPlan[] = scopeOrders.filter((o) => convertingPairs.has(o.pair_id)).map((o) => ({
            orderId: o.id, pairId: o.pair_id, symbol: o.symbol, side: o.side, type: o.type,
            remaining: o.remaining, limitPrice: o.limit_price, releasedAmount: o.releasable, releasedWalletId: o.reserved_wallet_id,
        }));
        const released = new Map<string, Decimal>();
        for (const c of cancels) {
            if (!c.releasedWalletId) continue;
            released.set(c.releasedWalletId, (released.get(c.releasedWalletId) ?? ZERO).plus(D(c.releasedAmount)));
        }

        const balances = new Map(scopeWallets.map((w) => [w.id, D(w.balance)]));
        const ledger: LedgerLine[] = [];
        const planned: PositionPlan[] = [];
        const after = new Map<string, { margin: Decimal }>(); // pair → converted margin

        for (const p of converting) {
            const qty = D(p.base_qty);
            const c = convertedPosition({ qty, entry: D(p.avg_entry_price), mmrBps: p.maintenance_margin_bps });
            const base = walletOf(p.base_asset_id);
            if (!base) {
                block("wallet_missing", `no ${p.symbol} base wallet in scope ${competitionId ?? "free-play"}`);
                continue;
            }
            if (c.side === "SHORT") {
                if (p.last_price === null) block("no_mark", `${p.symbol} has no last price to check the short's liq price against`);
                else if (D(p.last_price).gte(c.liqPrice)) {
                    block("short_past_liq", `${p.symbol} short: 1x liq ${toFixed8(c.liqPrice)} ≤ mark ${p.last_price}`);
                }
            }
            const baseBefore = balances.get(base.id)!;
            const baseAfter = baseBefore.plus(c.baseDelta);
            balances.set(base.id, baseAfter);
            balances.set(usd.id, balances.get(usd.id)!.plus(c.usdDelta));
            after.set(p.pair_id, { margin: c.margin });

            ledger.push(
                { walletId: base.id, asset: base.symbol, entryType: ENTRY_TYPE, amount: toFixed8(c.baseDelta), pairId: p.pair_id },
                { walletId: usd.id, asset: usd.symbol, entryType: ENTRY_TYPE, amount: toFixed8(c.usdSettle), pairId: p.pair_id },
                { walletId: usd.id, asset: usd.symbol, entryType: "MARGIN_LOCK", amount: toFixed8(c.margin.neg()), pairId: p.pair_id },
            );
            planned.push({
                pairId: p.pair_id, symbol: p.symbol, side: c.side, qty: toFixed8(qty), entry: toFixed8(D(p.avg_entry_price)),
                leverage: "1.00", margin: toFixed8(c.margin), liqPrice: toFixed8(c.liqPrice), mark: p.last_price,
                epochAfter: p.epoch + 1, baseWalletId: base.id, baseBefore: toFixed8(baseBefore), baseAfter: toFixed8(baseAfter),
                residue: toFixed8(baseAfter),
            });
        }

        const usdReservedAfter = D(usd.reserved).minus(released.get(usd.id) ?? ZERO);
        const usdAfter = balances.get(usd.id)!;
        if (usdAfter.lt(usdReservedAfter)) {
            block("insufficient_usd",
                `scope ${competitionId ?? "free-play"}: USD free after cancels ${toFixed8(D(usd.balance).minus(usdReservedAfter))}, `
                + `the shorts need ${toFixed8(D(usd.balance).minus(usdAfter))}`);
        }

        const cash = (bal: (w: WalletRow) => Decimal) =>
            scopeWallets.filter((w) => w.asset_id === quoteAssetId).reduce((s, w) => s.plus(bal(w)), ZERO);
        const equity = (converted: boolean): Decimal | null => {
            let total = cash((w) => (converted ? balances.get(w.id)! : D(w.balance)));
            for (const p of scopePositions) {
                if (D(p.base_qty).isZero()) continue;
                if (p.last_price === null) return null;
                const conv = converted ? after.get(p.pair_id) : undefined;
                total = total.plus(positionValue({
                    base_qty: p.base_qty,
                    avg_entry_price: p.avg_entry_price,
                    margin_mode: conv ? "ISOLATED" : p.margin_mode,
                    isolated_margin: conv ? toFixed8(conv.margin) : p.isolated_margin,
                }, D(p.last_price)).holdings);
            }
            return total;
        };
        const eqBefore = equity(false);
        const eqAfter = equity(true);

        plan.scopes.push({
            competitionId,
            usd: {
                walletId: usd.id,
                balanceBefore: toFixed8(D(usd.balance)),
                balanceAfter: toFixed8(usdAfter),
                reservedBefore: toFixed8(D(usd.reserved)),
                reservedAfter: toFixed8(usdReservedAfter),
            },
            equityBefore: eqBefore && toFixed8(eqBefore),
            equityAfter: eqAfter && toFixed8(eqAfter),
            positions: planned,
            cancels,
            ledger,
            otherSpotOrders: scopeOrders.filter((o) => !convertingPairs.has(o.pair_id)).length,
        });
    }
    return plan;
}

/** App equity of one scope, read from the database (the post-write check). */
async function scopeEquityTx(client: PoolClient, userId: string, competitionId: string | null, quoteAssetId: string): Promise<Decimal | null> {
    const { rows: [cash] } = await timedQuery<{ total: string }>(client, "leverageConversion.checkCash",
        `SELECT COALESCE(SUM(balance), 0)::text AS total FROM wallets
         WHERE user_id = $1 AND asset_id = $2 AND match_id IS NULL AND competition_id IS NOT DISTINCT FROM $3`,
        [userId, quoteAssetId, competitionId],
    );
    const { rows } = await timedQuery<{ base_qty: string; avg_entry_price: string; margin_mode: string; isolated_margin: string; last_price: string | null }>(
        client, "leverageConversion.checkPositions",
        `SELECT p.base_qty::text, p.avg_entry_price::text, p.margin_mode, p.isolated_margin::text, tp.last_price::text
         FROM positions p JOIN trading_pairs tp ON tp.id = p.pair_id
         WHERE p.user_id = $1 AND p.match_id IS NULL AND p.competition_id IS NOT DISTINCT FROM $2 AND p.base_qty <> 0`,
        [userId, competitionId],
    );
    let total = D(cash.total);
    for (const r of rows) {
        if (r.last_price === null) return null;
        total = total.plus(positionValue(r, D(r.last_price)).holdings);
    }
    return total;
}

// ── Running ─────────────────────────────────────────────────────────────

export type UserOutcome = {
    userId: string;
    email: string;
    status: "would_convert" | "converted" | "nothing" | "blocked" | "failed";
    reason?: string;
    plan?: UserPlan;
};

/** The dry run for one user: the plan, in a READ ONLY transaction. */
export async function previewUserConversion(userId: string): Promise<UserOutcome> {
    const client = await pool.connect();
    try {
        await client.query("BEGIN READ ONLY");
        const plan = await buildPlanTx(client, userId, false);
        await client.query("ROLLBACK");
        if (!plan) return { userId, email: "", status: "nothing" };
        if (plan.blocked) return { userId, email: plan.email, status: "blocked", reason: plan.blocked.reason, plan };
        return { userId, email: plan.email, status: "would_convert", plan };
    } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}

/**
 * Convert one user, in one transaction. Blocked → nothing written. Any
 * error → rolled back and rethrown. Events are published after COMMIT.
 */
export async function applyUserConversion(userId: string): Promise<UserOutcome> {
    if (await isSystemUser(userId)) return { userId, email: "", status: "nothing", reason: "system_user" };

    const client = await pool.connect();
    const events: AppEvent[] = [];
    let outcome: UserOutcome;
    try {
        await client.query("BEGIN");
        const plan = await buildPlanTx(client, userId, true);
        if (!plan) {
            await client.query("ROLLBACK");
            return { userId, email: "", status: "nothing" };
        }
        if (plan.blocked) {
            await client.query("ROLLBACK");
            return { userId, email: plan.email, status: "blocked", reason: plan.blocked.reason, plan };
        }

        const touched = new Set<string>();
        for (const scope of plan.scopes) {
            // 1. Resting SPOT orders on the converted pairs.
            for (const c of scope.cancels) {
                const { order, releasedAmount } = await cancelOrderTx(client, userId, c.orderId);
                await timedQuery(client, "leverageConversion.cancelReason",
                    `UPDATE orders SET cancel_reason = $2 WHERE id = $1`, [c.orderId, CONVERSION_CANCEL_REASON]);
                await insertOutboxEventTx(client, {
                    event_type: "EVENT_STREAM_APPEND",
                    aggregate_type: "ORDER",
                    aggregate_id: c.orderId,
                    payload: {
                        eventInput: {
                            eventType: "ORDER_CANCELLED",
                            entityType: "ORDER",
                            entityId: c.orderId,
                            actorUserId: userId,
                            payload: { pairId: c.pairId, releasedAmount, reason: CONVERSION_CANCEL_REASON },
                        },
                    },
                });
                events.push(createEvent("order.updated", {
                    orderId: order.id,
                    pairId: order.pair_id,
                    side: order.side as "BUY" | "SELL",
                    type: order.type as "MARKET" | "LIMIT",
                    status: order.status,
                    qty: order.qty,
                    filledQty: order.qty_filled,
                    limitPrice: order.limit_price ?? null,
                }, { userId }));
                if (order.reserved_wallet_id) touched.add(order.reserved_wallet_id);
            }

            // 2–5. Wallets, ledger and the position row.
            for (const p of scope.positions) {
                const meta = {
                    pairId: p.pairId, competitionId: scope.competitionId, epoch: p.epochAfter,
                    qty: p.qty, entry: p.entry, margin: p.margin, residue: p.residue,
                };
                const lines = scope.ledger.filter((l) => l.pairId === p.pairId);
                for (const l of lines) {
                    const amount = D(l.amount);
                    if (amount.isZero()) continue;
                    if (amount.isPositive()) {
                        await creditWalletTx(client, l.walletId, toFixed8(amount), l.entryType, undefined, ENTRY_TYPE, meta);
                    } else if (l.walletId === scope.usd.walletId) {
                        // USD never goes below what's reserved (insufficient_balance otherwise).
                        await debitAvailableTx(client, l.walletId, toFixed8(amount.neg()), l.entryType, undefined, ENTRY_TYPE, meta);
                    } else {
                        // Base: may stay negative by the residue of a drifted short.
                        await debitUnconstrainedTx(client, l.walletId, toFixed8(amount.neg()), l.entryType, undefined, ENTRY_TYPE, meta);
                    }
                    touched.add(l.walletId);
                }
                const { rowCount } = await timedQuery(client, "leverageConversion.convertPosition",
                    `UPDATE positions
                     SET margin_mode = 'ISOLATED', leverage = 1, isolated_margin = $5, liq_price = $6,
                         epoch = epoch + 1, opened_at = now(), updated_at = now()
                     WHERE user_id = $1 AND pair_id = $2 AND match_id IS NULL
                       AND competition_id IS NOT DISTINCT FROM $3::uuid
                       AND margin_mode = 'SPOT' AND base_qty = $4 AND epoch + 1 = $7`,
                    [userId, p.pairId, scope.competitionId, p.qty, p.margin, p.liqPrice, p.epochAfter],
                );
                if (rowCount !== 1) throw new Error(`position_changed ${p.symbol}`);
            }

            // Equity, recomputed from what was written.
            if (scope.equityBefore !== null) {
                const quoteAssetId = (await timedQuery<{ asset_id: string }>(client, "leverageConversion.usdAsset",
                    `SELECT asset_id FROM wallets WHERE id = $1`, [scope.usd.walletId])).rows[0].asset_id;
                const now = await scopeEquityTx(client, userId, scope.competitionId, quoteAssetId);
                if (now === null || now.minus(D(scope.equityBefore)).abs().gt(EQUITY_TOLERANCE)) {
                    throw new Error(`equity_mismatch scope=${scope.competitionId ?? "free-play"} before=${scope.equityBefore} after=${now ? toFixed8(now) : "n/a"}`);
                }
            }
        }

        await timedQuery(client, "leverageConversion.audit",
            `INSERT INTO audit_log (actor_user_id, action, target_type, target_id, metadata)
             VALUES (NULL, 'leverage.convert', 'user', $1, $2::jsonb)`,
            [userId, JSON.stringify({
                scopes: plan.scopes.map((s) => ({
                    competitionId: s.competitionId,
                    usdBefore: s.usd.balanceBefore,
                    usdAfter: s.usd.balanceAfter,
                    equityBefore: s.equityBefore,
                    equityAfter: s.equityAfter,
                    positions: s.positions.map((p) => ({ pairId: p.pairId, side: p.side, qty: p.qty, entry: p.entry, margin: p.margin, liqPrice: p.liqPrice, residue: p.residue })),
                    canceledOrders: s.cancels.map((c) => c.orderId),
                })),
            })],
        );
        events.push(...await walletUpdatedEventsTx(client, touched, ENTRY_TYPE));

        await client.query("COMMIT");
        outcome = { userId, email: plan.email, status: "converted", plan };
    } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
    } finally {
        client.release();
    }

    for (const e of events) {
        try { publish(e); } catch { /* events never break the caller */ }
    }
    return outcome;
}

export type ConversionRun = {
    mode: "DRY_RUN" | "APPLY";
    users: UserOutcome[];
    skippedSystemUsers: number;
    counts: { would_convert: number; converted: number; nothing: number; blocked: number; failed: number };
};

/**
 * Every user with an open non-match SPOT position (or just `userId`), one
 * at a time. Dry run unless `apply`. A failure is recorded and the run
 * goes on with the next user.
 */
export async function runConversion(opts: { apply: boolean; userId?: string }): Promise<ConversionRun> {
    const { rows } = await pool.query<{ user_id: string }>(
        `SELECT DISTINCT user_id FROM positions
         WHERE match_id IS NULL AND margin_mode = 'SPOT' AND base_qty <> 0
           AND ($1::uuid IS NULL OR user_id = $1::uuid)
         ORDER BY user_id`,
        [opts.userId ?? null],
    );
    const run: ConversionRun = {
        mode: opts.apply ? "APPLY" : "DRY_RUN",
        users: [],
        skippedSystemUsers: 0,
        counts: { would_convert: 0, converted: 0, nothing: 0, blocked: 0, failed: 0 },
    };
    for (const { user_id: userId } of rows) {
        if (await isSystemUser(userId)) {
            run.skippedSystemUsers++;
            continue;
        }
        let outcome: UserOutcome;
        try {
            outcome = opts.apply ? await applyUserConversion(userId) : await previewUserConversion(userId);
        } catch (err) {
            const { rows: [u] } = await pool.query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [userId]);
            outcome = { userId, email: u?.email ?? "", status: "failed", reason: err instanceof Error ? err.message : String(err) };
        }
        if (outcome.status === "nothing") {
            run.counts.nothing++;
            continue;
        }
        run.counts[outcome.status]++;
        run.users.push(outcome);
    }
    return run;
}

// ── Report ──────────────────────────────────────────────────────────────

const pad = (s: string, n: number) => s.padEnd(n);
const num = (s: string | null, n: number) => (s ?? "n/a").padStart(n);

export function formatRun(run: ConversionRun): string {
    const out: string[] = [];
    out.push(`=== leverage:convert [${run.mode === "APPLY" ? "APPLY" : "DRY RUN"}] ===`);
    out.push(`Open SPOT positions (free-play + competitions; matches, bots and @system.local excluded) → 1x ISOLATED at their entry.`);
    for (const u of run.users) {
        out.push("");
        out.push(`${u.email || "(no email)"}  user ${u.userId}  → ${u.status.toUpperCase()}${u.reason ? ` (${u.reason})` : ""}`);
        if (u.plan?.blocked) out.push(`  blocked: ${u.plan.blocked.detail}`);
        for (const s of u.plan?.scopes ?? []) {
            out.push(`  scope: ${s.competitionId ? `competition ${s.competitionId}` : "free-play"}`);
            out.push(`    USD       ${num(s.usd.balanceBefore, 18)} → ${num(s.usd.balanceAfter, 18)}   reserved ${s.usd.reservedBefore} → ${s.usd.reservedAfter}`);
            out.push(`    equity    ${num(s.equityBefore, 18)} → ${num(s.equityAfter, 18)}   (USD + positions at last price)`);
            out.push(`    positions:`);
            out.push(`      ${pad("pair", 10)}${pad("side", 6)}${num("qty", 14)}${num("entry", 16)}${num("margin", 16)}${num("liq", 16)}${num("mark", 16)}  base wallet → after (residue)`);
            for (const p of s.positions) {
                out.push(`      ${pad(p.symbol, 10)}${pad(p.side, 6)}${num(p.qty, 14)}${num(p.entry, 16)}${num(p.margin, 16)}${num(p.liqPrice, 16)}${num(p.mark, 16)}  `
                    + `${p.baseBefore} → ${p.baseAfter}${D(p.residue).isZero() ? "" : `  ⚠ residue ${p.residue} stays in the wallet`}`);
            }
            if (s.cancels.length > 0) {
                out.push(`    orders to cancel (${s.cancels.length}):`);
                for (const c of s.cancels) {
                    out.push(`      ${c.orderId}  ${pad(c.symbol, 10)}${pad(c.side, 5)}${pad(c.type, 7)}${num(c.remaining, 14)} @ ${c.limitPrice ?? "MKT"}  release ${c.releasedAmount}`);
                }
            }
            if (s.otherSpotOrders > 0) out.push(`    resting SPOT orders on other pairs, left as they are: ${s.otherSpotOrders}`);
            out.push(`    ledger:`);
            for (const l of s.ledger) out.push(`      ${pad(l.asset, 6)}${pad(l.entryType, 22)}${num(l.amount, 18)}`);
        }
    }
    out.push("");
    out.push(`=== summary (${run.mode === "APPLY" ? "APPLY" : "DRY RUN"}) ===`);
    if (run.mode === "APPLY") out.push(`  converted       ${run.counts.converted}`);
    else out.push(`  would convert   ${run.counts.would_convert}`);
    out.push(`  blocked         ${run.counts.blocked}`);
    out.push(`  failed          ${run.counts.failed}`);
    out.push(`  nothing to do   ${run.counts.nothing}   (converted by someone else meanwhile)`);
    out.push(`  system users    ${run.skippedSystemUsers}   (never converted)`);
    for (const u of run.users.filter((x) => x.status === "blocked" || x.status === "failed")) {
        out.push(`    ${u.status} ${u.userId} ${u.email}: ${u.reason}`);
    }
    out.push(run.mode === "APPLY"
        ? `Each user was its own transaction. Re-running converts only what is still SPOT.`
        : `DRY RUN — nothing written. Re-run with --apply to convert.`);
    return out.join("\n");
}

// ── CLI arguments ───────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `pnpm leverage:convert [--apply] [--user <uuid>]`. Without --apply it's a
 * dry run. Anything else is an error, so a typo can never mean "apply".
 */
export function parseConvertArgs(argv: string[]): { apply: boolean; userId?: string } {
    let apply = false;
    let userId: string | undefined;
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--apply") apply = true;
        else if (a === "--dry-run") continue;
        else if (a === "--user") {
            userId = argv[++i];
            if (!userId || !UUID_RE.test(userId)) throw new Error(`--user needs a user id (uuid), got ${userId ?? "nothing"}`);
        } else {
            throw new Error(`unknown argument: ${a} (usage: pnpm leverage:convert [--apply] [--user <uuid>])`);
        }
    }
    if (apply && argv.includes("--dry-run")) throw new Error("--apply and --dry-run together: pick one");
    return { apply, userId };
}
