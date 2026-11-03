/**
 * Chart layout catalog — the ids and params a saved chart layout may use.
 *
 * This file is duplicated byte-for-byte at apps/web/src/lib/chartLayouts/catalog.ts
 * (the apps share no package; same convention as marginCases.json). The web
 * suite fails if the two copies drift. Change both together.
 *
 * Adding an indicator: append its id here (both copies). Old layouts that
 * don't mention it load with it off. Removing one: the API then rejects it in
 * new writes, and the web skips it silently when applying an old layout.
 *
 * VPVR draws POC + VAH/VAL + the shaded value area together (vpvrPrimitive.ts),
 * so `vpvr` covers all three; `params.vpvr.mode` picks visible/weekly/daily.
 *
 * Params other than vpvr.mode are fixed in the chart today, so each allows
 * exactly the value the chart uses. Widen the list when the chart honors it.
 */
export const CHART_LAYOUT_CATALOG = {
    version: 1,
    indicators: [
        "ema20", "ema50", "ema200", "vwap", "bollingerBands", "volume", "rsi", "macd", "atr", "delta",
        "keyLevels", "liquidityZones", "orderBlocks", "cvd", "fundingRate", "openInterest", "vpvr",
        "orderbook", "footprint", "liquidationLevels", "cotReport",
    ],
    /** Sub-panes, in today's default render order. */
    panes: ["volume", "macd", "rsi", "atr", "delta", "cvd", "fundingRate", "openInterest", "cotReport"],
    timeframes: ["1m", "5m", "15m", "1h", "4h", "1d", "1w"],
    params: {
        vpvr: { mode: ["visible", "weekly", "daily"] },
        rsi: { period: [14] },
        atr: { period: [14] },
        macd: { fast: [12], slow: [26], signal: [9] },
        bollingerBands: { period: [20], stdDev: [2] },
    },
    paneHeight: { min: 40, max: 400 },
    nameMaxLength: 40,
    maxConfigBytes: 16384,
    maxLayoutsPerUser: 20,
} as const;

export type ChartIndicatorId = (typeof CHART_LAYOUT_CATALOG.indicators)[number];
export type ChartPaneId = (typeof CHART_LAYOUT_CATALOG.panes)[number];
export type ChartTimeframe = (typeof CHART_LAYOUT_CATALOG.timeframes)[number];
export type VpvrMode = (typeof CHART_LAYOUT_CATALOG.params.vpvr.mode)[number];

/** The saved config shape (v1). Every field but `version` is optional. */
export interface ChartLayoutConfig {
    version: 1;
    indicators?: Partial<Record<ChartIndicatorId, boolean>>;
    params?: {
        vpvr?: { mode: VpvrMode };
        rsi?: { period: 14 };
        atr?: { period: 14 };
        macd?: { fast: 12; slow: 26; signal: 9 };
        bollingerBands?: { period: 20; stdDev: 2 };
    };
    panes?: {
        order?: ChartPaneId[];
        collapsed?: Partial<Record<ChartPaneId, boolean>>;
        heights?: Partial<Record<ChartPaneId, number>>;
    };
    timeframe?: ChartTimeframe;
}
