export type SimulationConfig = {
    base_spread_bps: number;
    base_slippage_bps: number;
    impact_bps_per_10k_quote: number;
    liquidity_quote_per_tick: number;
    volatility_widening_k: number;
};

export type MarketExecutionResult = {
    execPrice: string;
    slippage_bps: string;
    spread_bps_effective: string;
    requestedNotional: string;
    availableLiquidityQuote: string;
};

export type SimQuoteResult = {
    executable: boolean;
    estimatedPrice: string;
    slippage_bps: string;
    requestedNotional: string;
    availableLiquidity: string;
};
