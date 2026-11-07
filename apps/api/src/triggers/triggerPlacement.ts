/**
 * The rules a user's TP/SL/trailing trigger passes before it exists, shared by
 * POST /v1/triggers, POST /v1/oco and PATCH /v1/triggers/:id.
 *
 * Triggers are placed apart from the order they go with, so "attached to an
 * order that only reduces" reaches the server as a trigger with nothing to
 * close: the position is the other way round (a BUY stop on a long) or gone.
 * Protecting what's left of a reduced position is fine, and stays allowed.
 *
 * Without this such a trigger sat ACTIVE and showed on the position card, and
 * only got canceled when it fired (fireTrigger's reduce-only clamp, no_position).
 *
 * TP/SL belong to the position, not to an order: at most one TP, one SL and one
 * trailing stop per position per scope, always at its full size. Sized from the
 * order instead, an add left part of the position unprotected. So any qty a
 * client sends is ignored.
 */
import { pool } from "../db/pool";
import { AppError } from "../errors/AppError";
import { publish } from "../events/eventBus";
import { D, toFixed8 } from "../utils/decimal";
import { REPLACED_REASON, triggerCanceledEvent } from "./positionCloseTriggers";
import { liveMidPrice } from "./trailingOffset";
import { shouldTrigger } from "./triggerEngine";
import { cancelTriggerSlotTx, createTriggerOrder, lockPositionQtyTx } from "./triggerRepo";
import type { TriggerKind, TriggerOrderRow } from "./triggerTypes";

interface TriggerLeg {
    kind: TriggerKind;
    side: "BUY" | "SELL";
    triggerPrice: string;
    limitPrice?: string;
    trailingOffset?: string;
}

/**
 * Stop and take-profit prices must sit where the engine won't fire them at the
 * mark: long SL below, long TP above, short the opposite. A trailing stop is
 * exempt: its offset sets the stop, the engine re-derives it on the first tick.
 */
export async function assertTriggerPrice(pairId: string, leg: TriggerLeg): Promise<void> {
    if (leg.kind === "TRAILING_STOP_MARKET") return;
    const mark = await liveMidPrice(pairId);
    const firesAtMark = shouldTrigger(
        { kind: leg.kind, side: leg.side, trigger_price: leg.triggerPrice } as TriggerOrderRow,
        { last: mark.toString() } as Parameters<typeof shouldTrigger>[1],
    );
    if (firesAtMark) {
        throw new AppError("trigger_wrong_side_of_mark", {
            kind: leg.kind, side: leg.side, triggerPrice: leg.triggerPrice, mark: mark.toFixed(8),
        });
    }
}

/** The kinds that share a position's one TP, one SL or one trailing stop. */
const SLOTS: TriggerKind[][] = [
    ["TAKE_PROFIT_MARKET", "TAKE_PROFIT_LIMIT"],
    ["STOP_MARKET", "STOP_LIMIT"],
    ["TRAILING_STOP_MARKET"],
];
const slotOf = (kind: TriggerKind) => SLOTS.find((slot) => slot.includes(kind))!;

/**
 * Put `legs` on the position, at its full size, each replacing what's in its
 * slot. All or nothing: an OCO is checked before anything changes. The position
 * row stays locked to the end, so a fill can't resize it under this; fills then
 * keep the size right (resizeTriggersToPositionTx).
 */
export async function placePositionTriggers(
    userId: string,
    pairId: string,
    matchId: string | null,
    legs: TriggerLeg[],
    ocoGroupId?: string,
): Promise<TriggerOrderRow[]> {
    if (new Set(legs.map((leg) => slotOf(leg.kind))).size !== legs.length) {
        throw new AppError("invalid_input", { message: "An OCO pair needs two different kinds: a TP and an SL." });
    }
    for (const leg of legs) await assertTriggerPrice(pairId, leg);

    const client = await pool.connect();
    const replaced: TriggerOrderRow[] = [];
    const placed: TriggerOrderRow[] = [];
    try {
        await client.query("BEGIN");
        const position = D(await lockPositionQtyTx(client, userId, pairId, matchId));
        for (const leg of legs) {
            if (leg.side === "SELL" ? position.lte(0) : position.gte(0)) {
                throw new AppError("trigger_not_reducing", { side: leg.side });
            }
        }
        for (const leg of legs) {
            replaced.push(...await cancelTriggerSlotTx(client, userId, pairId, matchId, slotOf(leg.kind), REPLACED_REASON));
            placed.push(await createTriggerOrder({
                userId,
                pairId,
                kind: leg.kind,
                side: leg.side,
                triggerPrice: leg.triggerPrice,
                limitPrice: leg.limitPrice,
                qty: toFixed8(position.abs()),
                ocoGroupId,
                trailingOffset: leg.trailingOffset,
                trailingHighWaterMark: leg.kind === "TRAILING_STOP_MARKET" ? leg.triggerPrice : undefined,
                matchId,
            }, client));
        }
        await client.query("COMMIT");
    } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
    } finally {
        client.release();
    }

    for (const row of replaced) publish(triggerCanceledEvent(row, REPLACED_REASON));
    return placed;
}
