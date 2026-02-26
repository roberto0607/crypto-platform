import Decimal from "decimal.js";
import { D, BPS_DIVISOR, toFixed8 } from "../utils/decimal";

export type FeeRole = "MAKER" | "TAKER";

export type FeeResult = {
    feeAmount: string;
    feeAssetId: string;
    role: FeeRole;
};

/**
 * Compute the fee for one side of a fill.
 *
 * - Resting order (book) = MAKER → uses pair.maker_fee_bps
 * - Incoming order (aggressor) = TAKER → uses pair.taker_fee_bps
 *
 * Fee is always charged in quote asset: fee = quoteAmount * bps / 10000
 */
export function computeFee(
    quoteAmount: string,
    role: FeeRole,
    makerFeeBps: number,
    takerFeeBps: number,
    quoteAssetId: string
): FeeResult {
    const bps = role === "MAKER" ? makerFeeBps : takerFeeBps;
    const fee = D(quoteAmount).mul(D(bps)).div(BPS_DIVISOR);
    return {
        feeAmount: toFixed8(fee),
        feeAssetId: quoteAssetId,
        role,
    };
}

/**
 * Compute both maker and taker fees for a single fill.
 * Returns { taker, maker } fee results.
 */
export function computeFillFees(
    quoteAmount: string,
    makerFeeBps: number,
    takerFeeBps: number,
    quoteAssetId: string
): { taker: FeeResult; maker: FeeResult } {
    return {
        taker: computeFee(quoteAmount, "TAKER", makerFeeBps, takerFeeBps, quoteAssetId),
        maker: computeFee(quoteAmount, "MAKER", makerFeeBps, takerFeeBps, quoteAssetId),
    };
}
