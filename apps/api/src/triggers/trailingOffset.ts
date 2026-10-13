/**
 * Trailing-stop offset validation, shared by POST /v1/triggers, POST /v1/oco
 * and PATCH /v1/triggers/:id.
 *
 * The offset is a USD price distance from the high-water mark (stop =
 * hwm - offset for a SELL, hwm + offset for a BUY; triggerEngine
 * updateTrailingStop). So it must be > 0 and below the current price. At or
 * above the price, a long's stop sits at or below zero (the engine clamps it
 * to 0), so it can never fire. The web order panel applies the same rule
 * (trailingOffsetError in UnifiedOrderPanel.tsx).
 */
import { AppError } from "../errors/AppError";
import { findPairById } from "../trading/pairRepo";
import { getMarketReference } from "../trading/priceCollar";

/** Why `offset` is not a valid trailing offset at `price`, or null when it is. */
export function trailingOffsetError(offset: number, price: number): string | null {
    if (!Number.isFinite(offset) || offset <= 0) return "trailingOffset must be greater than 0";
    if (offset >= price) return "trailingOffset must be less than the current price";
    return null;
}

/**
 * Throw invalid_input unless 0 < offset < the pair's live mid price. With no
 * fresh price, throw stale_price_source (503), the same as a market order.
 */
export async function assertTrailingOffset(pairId: string, offset: string): Promise<void> {
    const pair = await findPairById(pairId);
    if (!pair) throw new AppError("pair_not_found");
    const ref = await getMarketReference(pairId, pair.symbol);
    if (!ref) throw new AppError("stale_price_source");
    const price = ref.bestBid.plus(ref.bestAsk).div(2).toNumber();
    const error = trailingOffsetError(Number(offset), price);
    if (error) throw new AppError("invalid_input", { message: error, trailingOffset: offset, price: price.toFixed(8) });
}
