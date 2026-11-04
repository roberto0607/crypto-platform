import { D, toFixed8, BPS_DIVISOR } from "../utils/decimal";
import type { SimulationConfig, MarketExecutionResult } from "./simTypes";
import type { Snapshot } from "../market/snapshotStore";

/**
 * A solo replay session's MARKET fill, priced off the historical candle (it has
 * no live book). Live orders are priced by trading/marketFillPrice.ts.
 */
export function computeMarketExecution(
    snapshot: Snapshot,
    side: "BUY" | "SELL",
    qty: string,
    config: SimulationConfig,
    candleVolume: string | null,
    candleHigh: string | null,
    candleLow: string | null
): MarketExecutionResult {
    const last = D(snapshot.last);
    const quantity = D(qty);
    const requestedNotional = quantity.mul(last);

    // Spread (volatility-widened)
    let spreadBps = D(config.base_spread_bps);
    if (candleHigh && candleLow) {
        const range = D(candleHigh).minus(D(candleLow));
        const volatilityBps = range.div(last).mul(D(10000));
        spreadBps = spreadBps.plus(D(config.volatility_widening_k).mul(volatilityBps));
    }

    // Derive bid/ask from last + spread
    const halfSpread = spreadBps.div(D(20000));
    const ask = last.mul(D(1).plus(halfSpread));
    const bid = last.mul(D(1).minus(halfSpread));

    // Slippage
    const slippageBps = D(config.base_slippage_bps).plus(
        requestedNotional
            .div(D(config.liquidity_quote_per_tick))
            .mul(D(config.impact_bps_per_10k_quote))
    );

    // Execution price
    const execPrice = side === "BUY"
        ? ask.mul(D(1).plus(slippageBps.div(BPS_DIVISOR)))
        : bid.mul(D(1).minus(slippageBps.div(BPS_DIVISOR)));

    return {
        execPrice: toFixed8(execPrice),
        slippage_bps: toFixed8(slippageBps),
        spread_bps_effective: toFixed8(spreadBps),
        requestedNotional: toFixed8(requestedNotional),
    };
}
