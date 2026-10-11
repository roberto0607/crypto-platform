import { D, BPS_DIVISOR, toFixed8 } from "../utils/decimal";
import { config } from "../config";

export type FeeRole = "MAKER" | "TAKER";

/** The fee columns of a trading_pairs row. */
export type PairFeeRates = {
    maker_fee_bps: number;
    taker_fee_bps: number;
};

export type FeeResult = {
    feeAmount: string;
    feeAssetId: string;
    role: FeeRole;
};

/**
 * The single source of truth for fee rates. The matching engine (wallet
 * debits/credits), positions and the journal all go through here.
 *
 * - Incoming order (aggressor) = TAKER → pair.taker_fee_bps
 * - Resting order (book)       = MAKER → pair.maker_fee_bps
 * - The market-maker bot pays no maker fee: it provides the book's
 *   liquidity, and a maker fee would only drain its paper balance.
 *
 * trading_pairs.fee_bps is deprecated (migration 010) and must not be read.
 */
export function feeBpsFor(pair: PairFeeRates, role: FeeRole, userId?: string | null): number {
    if (role === "MAKER") {
        return userId === config.botUserId ? 0 : pair.maker_fee_bps;
    }
    return pair.taker_fee_bps;
}

/**
 * Highest rate an order can be charged, whichever role it ends up in.
 * Used to size LIMIT reserves so a resting order can always cover its fee.
 */
export function maxFeeBps(pair: PairFeeRates): number {
    return Math.max(pair.maker_fee_bps, pair.taker_fee_bps);
}

/**
 * Fee for one side of a fill, always charged in the quote asset:
 * fee = quoteAmount * bps / 10000, rounded to 8 dp.
 *
 * Pass the already-rounded quote amount (the trade's quote_amount) so every
 * caller derives the identical fee from the identical input.
 */
export function computeFee(
    quoteAmount: string,
    role: FeeRole,
    pair: PairFeeRates & { quote_asset_id: string },
    userId?: string | null,
): FeeResult {
    const bps = feeBpsFor(pair, role, userId);
    const fee = D(quoteAmount).mul(D(bps)).div(BPS_DIVISOR);
    return {
        feeAmount: toFixed8(fee),
        feeAssetId: pair.quote_asset_id,
        role,
    };
}
