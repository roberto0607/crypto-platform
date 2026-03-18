import { D, toFixed8, BPS_DIVISOR } from "../utils/decimal";
import type { SimulationConfig, MarketExecutionResult } from "./simTypes";
import { computeAvailableLiquidity } from "./liquidityModel";
import type { Snapshot } from "../market/snapshotStore";

export function computeMarketExecution(
    snapshot: Snapshot,
    side: "BUY" | "SELL",
    qty: string,
    config: SimulationConfig,
    candleVolume: string | null,
    candleHigh: string | null,
    candleLow: string | null
): MarketExecutionResult | null {
    const last = D(snapshot.last);
    const quantity = D(qty);
    const requestedNotional = quantity.mul(last);

    // Liquidity check (floor of $10,000 for paper trading)
    const availStr = computeAvailableLiquidity(config, candleVolume, snapshot.last);
    const MIN_LIQUIDITY = D("10000");
    const availableLiquidityQuote = D(availStr).lt(MIN_LIQUIDITY) ? MIN_LIQUIDITY : D(availStr);

    if (requestedNotional.gt(availableLiquidityQuote)) {
        return null;
    }

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
        availableLiquidityQuote: availStr,
    };
}
