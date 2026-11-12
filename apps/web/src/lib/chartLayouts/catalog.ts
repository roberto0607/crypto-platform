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
 * Params other than vpvr.mode, supportResistanceOptions and the moving
 * averages are fixed in the chart today, so each allows exactly the value the
 * chart uses. Widen the list when the chart honors it.
 *
 * Moving averages are a list (`params.movingAverages`), not toggles. Layouts
 * saved before that used the `ema20`/`ema50`/`ema200` toggles: migration 109
 * rewrote stored rows, the API converts them on write (a tab still running the
 * old build), and the web converts them on read — all with
 * `upgradeLegacyEmaConfig` below (the SQL mirrors it; a test holds them equal).
 */
export const CHART_LAYOUT_CATALOG = {
    version: 1,
    indicators: [
        "vwap", "bollingerBands", "volume", "rsi", "macd", "atr", "delta",
        "keyLevels", "liquidityZones", "orderBlocks", "cvd", "fundingRate", "openInterest", "vpvr",
        "orderbook", "footprint", "liquidationLevels", "cotReport", "adx", "utBot", "swings",
        "supportResistance",
    ],
    /** Sub-panes, in today's default render order. */
    panes: ["volume", "macd", "rsi", "atr", "delta", "cvd", "fundingRate", "openInterest", "cotReport", "adx"],
    timeframes: ["1m", "5m", "15m", "1h", "4h", "1d", "1w"],
    params: {
        vpvr: { mode: ["visible", "weekly", "daily"] },
        rsi: { period: [14] },
        atr: { period: [14] },
        macd: { fast: [12], slow: [26], signal: [9] },
        bollingerBands: { period: [20], stdDev: [2] },
        /**
         * Support/resistance switches (the first value is the default):
         * higher-timeframe levels to add, broken levels drawn faded or hidden,
         * the break volume filter, and the max-age flag.
         */
        supportResistanceOptions: {
            htf: ["off", "1d", "1w", "1d+1w"],
            showBroken: ["on", "off"],
            volumeFilter: ["off", "on"],
            maxAge: ["off", "on"],
        },
    },
    /**
     * Editable numeric params: [min, max, step]. step 1 = whole numbers only.
     * Defaults are TradingView's (built-in ADX/DMI; "UT Bot Alerts").
     */
    numericParams: {
        adx: {
            diLength: { min: 1, max: 200, step: 1, default: 14 },
            adxSmoothing: { min: 1, max: 200, step: 1, default: 14 },
            threshold: { min: 1, max: 99, step: 1, default: 25 },
        },
        utBot: {
            keyValue: { min: 0.1, max: 20, step: 0.1, default: 1 },
            atrPeriod: { min: 1, max: 200, step: 1, default: 10 },
        },
        /**
         * Support/resistance (packages/indicators supportResistance.ts).
         * left/right = pivot bars each side; distances are × ATR(14):
         * mergeAtr = merge a pivot into a level, breakAtr = close beyond the
         * zone to break it, maxZoneAtr = widest zone a merge may make.
         * volumeMult = break volume vs the 20-bar average (volume filter on);
         * nearest = levels above and below price drawn in full; maxAgeBars =
         * older active levels are faded and flagged (max age on);
         * htfLeft/htfRight = pivot bars for the 1D/1W levels.
         */
        supportResistance: {
            left: { min: 2, max: 50, step: 1, default: 10 },
            right: { min: 2, max: 50, step: 1, default: 10 },
            mergeAtr: { min: 0.1, max: 2, step: 0.05, default: 0.5 },
            breakAtr: { min: 0, max: 2, step: 0.05, default: 0.25 },
            maxZoneAtr: { min: 0.5, max: 5, step: 0.1, default: 1.5 },
            volumeMult: { min: 1, max: 5, step: 0.1, default: 1.5 },
            nearest: { min: 1, max: 10, step: 1, default: 3 },
            maxAgeBars: { min: 1, max: 5000, step: 1, default: 200 },
            htfLeft: { min: 2, max: 50, step: 1, default: 5 },
            htfRight: { min: 2, max: 50, step: 1, default: 5 },
        },
    },
    movingAverages: {
        maxLines: 10,
        types: ["EMA", "SMA"],
        length: { min: 1, max: 500 },
        /**
         * The timeframe a line is computed on: "chart" (the default, also when
         * missing) or a higher one, drawn as a step line from CLOSED bars of
         * that timeframe (packages/indicators htf.ts). `forming: true` also
         * shows the still-forming bar's value, dotted, at the right edge.
         */
        timeframes: ["chart", "1h", "4h", "1d", "1w"],
        /** Line ids: lowercase letters/digits, unique within a layout. */
        idPattern: "^[a-z0-9]{1,16}$",
        /** `#rrggbb`. */
        colorPattern: "^#[0-9a-fA-F]{6}$",
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
export type MovingAverageType = (typeof CHART_LAYOUT_CATALOG.movingAverages.types)[number];
export type SupportResistanceOptions = {
    [K in keyof typeof CHART_LAYOUT_CATALOG.params.supportResistanceOptions]: (typeof CHART_LAYOUT_CATALOG.params.supportResistanceOptions)[K][number];
};
export type MovingAverageTimeframe = (typeof CHART_LAYOUT_CATALOG.movingAverages.timeframes)[number];

/** One moving-average line on the price chart. */
export interface MovingAverageSpec {
    id: string;
    type: MovingAverageType;
    length: number;
    color: string;
    /** Missing = "chart". */
    timeframe?: MovingAverageTimeframe;
    /** Higher timeframe only: also draw the forming bar's value (dotted). */
    forming?: boolean;
}

export interface AdxParams {
    diLength: number;
    adxSmoothing: number;
    /** The horizontal "trend" line (TradingView convention: 25). */
    threshold: number;
}

export interface UtBotParams {
    keyValue: number;
    atrPeriod: number;
}

export interface SupportResistanceParams {
    left: number;
    right: number;
    mergeAtr: number;
    breakAtr: number;
    maxZoneAtr: number;
    volumeMult: number;
    nearest: number;
    maxAgeBars: number;
    htfLeft: number;
    htfRight: number;
}

/** Golden/death-cross markers between two of the lines (by id). */
export interface MaCrossSpec {
    fast: string;
    slow: string;
}

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
        movingAverages?: MovingAverageSpec[];
        maCross?: MaCrossSpec;
        adx?: AdxParams;
        utBot?: UtBotParams;
        supportResistance?: SupportResistanceParams;
        supportResistanceOptions?: SupportResistanceOptions;
    };
    panes?: {
        order?: ChartPaneId[];
        collapsed?: Partial<Record<ChartPaneId, boolean>>;
        heights?: Partial<Record<ChartPaneId, number>>;
    };
    timeframe?: ChartTimeframe;
}

// ── Pre-list EMA toggles ───────────────────────────────────────────────────

/** The old fixed EMA toggles, in their old colors. */
export const LEGACY_EMA_TOGGLES = [
    { key: "ema20", length: 20, color: "#3b82f6" },
    { key: "ema50", length: 50, color: "#f59e0b" },
    { key: "ema200", length: 200, color: "#ef4444" },
] as const;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Convert a config that uses the old `ema20`/`ema50`/`ema200` toggles: each
 * one that was on becomes an EMA line with the same length and color (id =
 * the old key), and with EMA 50 and 200 both on the golden/death-cross
 * markers stay on them, as before. The old keys are removed. A config that
 * already has `params.movingAverages` keeps its lines. Returns the input
 * itself when there is nothing to convert. Mirrored by migration 109.
 */
export function upgradeLegacyEmaConfig<T>(raw: T): T {
    if (!isPlainObject(raw) || !isPlainObject(raw.indicators)) return raw;
    const indicators: Record<string, unknown> = { ...raw.indicators };
    if (!LEGACY_EMA_TOGGLES.some((l) => l.key in indicators)) return raw;

    const on = LEGACY_EMA_TOGGLES.filter((l) => indicators[l.key] === true);
    for (const l of LEGACY_EMA_TOGGLES) delete indicators[l.key];
    const out: Record<string, unknown> = { ...raw, indicators };

    const params: Record<string, unknown> = isPlainObject(raw.params) ? { ...raw.params } : {};
    if (on.length > 0 && !("movingAverages" in params)) {
        params.movingAverages = on.map((l) => ({ id: l.key, type: "EMA", length: l.length, color: l.color }));
        const has = (k: string) => on.some((l) => l.key === k);
        if (has("ema50") && has("ema200") && !("maCross" in params)) params.maCross = { fast: "ema50", slow: "ema200" };
        out.params = params;
    }
    return out as T;
}
