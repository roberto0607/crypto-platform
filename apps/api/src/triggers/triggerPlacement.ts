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
 */
import { AppError } from "../errors/AppError";
import { D } from "../utils/decimal";
import { liveMidPrice } from "./trailingOffset";
import { shouldTrigger } from "./triggerEngine";
import { reducibleQty } from "./triggerRepo";
import type { TriggerKind, TriggerOrderRow } from "./triggerTypes";

interface TriggerLeg {
    kind: TriggerKind;
    side: "BUY" | "SELL";
    triggerPrice: string;
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

/** Check every leg before any is created, so an OCO is all or nothing. */
export async function assertTriggerPlacement(
    userId: string,
    pairId: string,
    matchId: string | null,
    legs: TriggerLeg[],
): Promise<void> {
    for (const leg of legs) {
        const reducible = await reducibleQty(userId, pairId, leg.side, { competitionId: null, matchId });
        if (D(reducible).lte(0)) throw new AppError("trigger_not_reducing", { side: leg.side });
        await assertTriggerPrice(pairId, leg);
    }
}
