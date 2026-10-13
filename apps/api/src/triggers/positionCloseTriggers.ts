/**
 * Closing a position cancels the TP/SL/trailing triggers protecting it.
 *
 * Every trigger kind exists to reduce a position (they are reduce-only at fire
 * time, see triggerEngine.fireTrigger), so once the position is gone they are
 * orphans: left ACTIVE, a stale stop could later fire a market order against
 * nothing. QA 2026-10-11 found exactly that in prod — closing a short left its
 * BUY TP and SL armed and invisible.
 *
 * Triggers are scoped (trigger_orders.match_id: the match they were created
 * in, or null = free-play), and a close only cancels triggers in the scope of
 * the position it closed.
 *
 * Close paths:
 *   - any fill through placeOrderWithSnapshot — manual CLOSE POSITION, a
 *     TP/SL/trailing fire, a normal order that crosses through zero, and the
 *     maker side when a user's resting limit order closes their position
 *     → cancelTriggersForClosedPositionTx (reason position_closed)
 *   - match end (complete / forfeit / mutual forfeit / cancel) → every ACTIVE
 *     trigger of that match, via cancelMatchTriggersTx (reason match_ended)
 * A future liquidation engine must place its closing order through
 * placeOrderWithSnapshot (or call this module) to get the same cleanup.
 */
import type { PoolClient } from "pg";
import { D } from "../utils/decimal";
import { createEvent } from "../events/eventTypes";
import { cancelReducingTriggersTx } from "./triggerRepo";
import type { TriggerOrderRow } from "./triggerTypes";

export const POSITION_CLOSED_REASON = "position_closed";
export const MATCH_ENDED_REASON = "match_ended";

/**
 * Which trigger side protected a position that this fill just closed, or null
 * if the fill didn't close one. A SELL that takes a long to flat or short
 * closes the long, whose triggers are SELLs; a BUY that takes a short to flat
 * or long closes the short, whose triggers are BUYs.
 *
 * @param afterQty the position's base_qty after the fill was applied
 */
export function closedTriggerSide(
    fillSide: "BUY" | "SELL",
    fillQty: string,
    afterQty: string,
): "BUY" | "SELL" | null {
    const after = D(afterQty);
    const before = fillSide === "BUY" ? after.minus(fillQty) : after.plus(fillQty);
    if (before.gt(0) && after.lte(0)) return "SELL";
    if (before.lt(0) && after.gte(0)) return "BUY";
    return null;
}

/**
 * Cancel the user's ACTIVE `triggerSide` triggers on the pair in the scope of
 * the position that just closed, unless a position in that direction remains
 * in that scope. Competition-scoped positions have no triggers (derived
 * orders are only ever free-play or match), so closing one cancels nothing.
 * Runs in the caller's transaction; publish the returned events after COMMIT.
 */
export async function cancelTriggersForClosedPositionTx(
    client: PoolClient,
    userId: string,
    pairId: string,
    triggerSide: "BUY" | "SELL",
    scope: { competitionId: string | null; matchId: string | null },
): Promise<TriggerOrderRow[]> {
    if (scope.competitionId !== null) return [];
    return cancelReducingTriggersTx(client, userId, pairId, triggerSide, scope.matchId, POSITION_CLOSED_REASON);
}

export function triggerCanceledEvent(row: TriggerOrderRow, reason: string) {
    return createEvent(
        "trigger.canceled",
        { triggerId: row.id, pairId: row.pair_id, reason },
        { userId: row.user_id },
    );
}
