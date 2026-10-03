/**
 * restrictPairs.ts — one-time, reversible data step that brings
 * trading_pairs.is_active in line with the MARKET_SYMBOLS allowlist: every
 * active pair outside it is flipped to is_active = false. No rows, wallets,
 * positions or history are deleted.
 *
 * The code already treats non-allowlisted pairs as gone (not listed, not
 * tradable, not streamed — see marketSymbols.ts), so this is data hygiene,
 * not the enforcement itself. Driven by src/scripts/restrictPairs.ts.
 *
 * Safety:
 *   - A pair holding an OPEN/PARTIALLY_FILLED order or an ACTIVE trigger is
 *     never deactivated unless those are canceled first (cancelOpen), so no
 *     reserved funds are stranded. The check is IN the UPDATE's own WHERE
 *     (atomic, no TOCTOU) and a mismatch throws and rolls back — same
 *     pattern as symbolSync.deactivatePairsGuarded().
 *   - Open positions do NOT block: they stay as rows, valued at the pair's
 *     last price. They could not be traded either way once the allowlist
 *     code is live.
 *   - Reversible: the caller records the returned pair ids; revertPairs()
 *     flips exactly those back.
 */
import { pool } from "../db/pool.js";
import { config } from "../config.js";
import { tradableSymbols } from "./marketSymbols.js";
import { cancelAllOrdersWithOutbox } from "../trading/phase6OrderService.js";

export interface RestrictionTarget {
    id: string;
    symbol: string;
    openPositions: number;
    openOrders: number;
    activeTriggers: number;
    activeAlerts: number;
}

export interface RestrictionPlan {
    allowed: string[];          // the allowlist
    keep: string[];             // active allowlisted pairs (stay active)
    missingAllowed: string[];   // allowlisted symbols with no active row — worth a look
    targets: RestrictionTarget[]; // active pairs that would be deactivated
}

const BLOCKING_SQL = `
    EXISTS (SELECT 1 FROM orders o
             WHERE o.pair_id = tp.id AND o.status IN ('OPEN', 'PARTIALLY_FILLED'))
    OR EXISTS (SELECT 1 FROM trigger_orders t
                WHERE t.pair_id = tp.id AND t.status = 'ACTIVE')`;

export async function planRestriction(
    allow: ReadonlySet<string> = config.marketSymbols,
): Promise<RestrictionPlan> {
    const allowed = tradableSymbols(allow);
    const { rows } = await pool.query<{
        id: string; symbol: string; allowed: boolean;
        open_positions: string; open_orders: string; active_triggers: string; active_alerts: string;
    }>(
        `SELECT tp.id, tp.symbol, tp.symbol = ANY($1) AS allowed,
                (SELECT count(*) FROM positions p WHERE p.pair_id = tp.id AND p.base_qty <> 0) AS open_positions,
                (SELECT count(*) FROM orders o WHERE o.pair_id = tp.id AND o.status IN ('OPEN', 'PARTIALLY_FILLED')) AS open_orders,
                (SELECT count(*) FROM trigger_orders t WHERE t.pair_id = tp.id AND t.status = 'ACTIVE') AS active_triggers,
                (SELECT count(*) FROM alerts a WHERE a.pair_id = tp.id AND a.status = 'ACTIVE') AS active_alerts
           FROM trading_pairs tp
          WHERE tp.is_active = true
          ORDER BY tp.symbol`,
        [allowed],
    );

    const keep = rows.filter((r) => r.allowed).map((r) => r.symbol);
    return {
        allowed,
        keep,
        missingAllowed: allowed.filter((s) => !keep.includes(s)),
        targets: rows.filter((r) => !r.allowed).map((r) => ({
            id: r.id,
            symbol: r.symbol,
            openPositions: Number(r.open_positions),
            openOrders: Number(r.open_orders),
            activeTriggers: Number(r.active_triggers),
            activeAlerts: Number(r.active_alerts),
        })),
    };
}

export interface RestrictionResult {
    deactivated: { id: string; symbol: string }[];
    skipped: { id: string; symbol: string; reason: string }[];
    canceledOrderIds: string[];
    canceledTriggerIds: string[];
    canceledAlertIds: string[];
}

/**
 * Deactivate `targets` (from planRestriction). With cancelOpen, first cancels
 * their open orders (normal cancel path — releases reservations, emits
 * events), ACTIVE triggers and ACTIVE alerts. Without it, any target that
 * still holds an open order/trigger is skipped and reported.
 */
export async function applyRestriction(
    targets: readonly RestrictionTarget[],
    opts: { cancelOpen?: boolean; allow?: ReadonlySet<string> } = {},
): Promise<RestrictionResult> {
    const allowed = tradableSymbols(opts.allow ?? config.marketSymbols);
    const result: RestrictionResult = {
        deactivated: [], skipped: [], canceledOrderIds: [], canceledTriggerIds: [], canceledAlertIds: [],
    };
    if (targets.length === 0) return result;
    const ids = targets.map((t) => t.id);

    if (opts.cancelOpen) {
        for (const id of ids) {
            const { canceled } = await cancelAllOrdersWithOutbox({ pairId: id }, "restrict-pairs");
            result.canceledOrderIds.push(...canceled.map((c) => c.order.id));
        }
    }

    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        if (opts.cancelOpen) {
            const trig = await client.query<{ id: string }>(
                `UPDATE trigger_orders SET status = 'CANCELED'
                  WHERE pair_id = ANY($1::uuid[]) AND status = 'ACTIVE'
                  RETURNING id`,
                [ids],
            );
            result.canceledTriggerIds = trig.rows.map((r) => r.id);
            const alerts = await client.query<{ id: string }>(
                `UPDATE alerts SET status = 'CANCELLED'
                  WHERE pair_id = ANY($1::uuid[]) AND status = 'ACTIVE'
                  RETURNING id`,
                [ids],
            );
            result.canceledAlertIds = alerts.rows.map((r) => r.id);
        }

        // Which targets are blocked right now (same predicate as the guard).
        const { rows: blocked } = await client.query<{ id: string; symbol: string }>(
            `SELECT tp.id, tp.symbol FROM trading_pairs tp
              WHERE tp.id = ANY($1::uuid[]) AND (${BLOCKING_SQL})`,
            [ids],
        );
        const blockedIds = new Set(blocked.map((b) => b.id));
        for (const b of blocked) {
            result.skipped.push({ ...b, reason: "holds an open order or active trigger (re-run with --cancel-open)" });
        }
        const nominees = targets.filter((t) => !blockedIds.has(t.id));

        // Atomic guard: allowlist + nothing blocking, in the UPDATE itself.
        const { rows: done } = await client.query<{ id: string; symbol: string }>(
            `UPDATE trading_pairs tp
                SET is_active = false
              WHERE tp.id = ANY($1::uuid[])
                AND tp.is_active = true
                AND NOT (tp.symbol = ANY($2))
                AND NOT (${BLOCKING_SQL})
              RETURNING tp.id, tp.symbol`,
            [nominees.map((n) => n.id), allowed],
        );
        if (done.length !== nominees.length) {
            throw new Error(
                `restrictPairs: guard mismatch — expected ${nominees.length} deactivations, got ${done.length}. `
                + `Something changed mid-run; rolled back, nothing deactivated.`,
            );
        }
        result.deactivated = done;

        await client.query("COMMIT");
    } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
    } finally {
        client.release();
    }
    return result;
}

/** Undo: re-activate exactly these pair ids (those currently inactive). */
export async function revertPairs(pairIds: readonly string[]): Promise<{ id: string; symbol: string }[]> {
    if (pairIds.length === 0) return [];
    const { rows } = await pool.query<{ id: string; symbol: string }>(
        `UPDATE trading_pairs SET is_active = true
          WHERE id = ANY($1::uuid[]) AND is_active = false
          RETURNING id, symbol`,
        [pairIds],
    );
    return rows;
}
