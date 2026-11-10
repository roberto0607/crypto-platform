/**
 * Chart layouts — pure logic (no React, no stores).
 *
 * A ChartState is everything a layout controls, fully resolved. A
 * ChartLayoutConfig is what gets saved (catalog.ts; the API validates it
 * strictly). Reading a config is TOLERANT, the opposite of the API:
 *   - an indicator/pane id this build doesn't know is skipped silently
 *     (it was removed since the layout was saved);
 *   - an indicator the config doesn't mention is OFF (added since);
 *   - anything else unspecified or malformed (timeframe, VPVR mode, pane
 *     collapsed/height, panes missing from `order`) keeps the CURRENT value
 *     (or, for order, today's default position), so a layout only changes
 *     what it actually names.
 *   - moving averages are part of "which indicators are on": a config without
 *     `params.movingAverages` draws none. Old configs' ema20/50/200 toggles
 *     are converted first (upgradeLegacyEmaConfig, shared with the API).
 */
import type { Timeframe } from "@/api/endpoints/candles";
import {
    CHART_LAYOUT_CATALOG as C,
    type ChartIndicatorId,
    type ChartLayoutConfig,
    type ChartPaneId,
    type MaCrossSpec,
    type MovingAverageSpec,
    type VpvrMode,
    upgradeLegacyEmaConfig,
} from "./catalog";

export type IndicatorToggles = Record<ChartIndicatorId, boolean>;

/** Indicator settings a layout saves besides the on/off toggles. */
export interface IndicatorSettings {
    movingAverages: MovingAverageSpec[];
    /** Golden/death-cross markers between two of the lines, or none. */
    maCross: MaCrossSpec | null;
}

export const DEFAULT_INDICATOR_SETTINGS: Readonly<IndicatorSettings> = { movingAverages: [], maCross: null };

export interface ChartState {
    indicators: IndicatorToggles;
    settings: IndicatorSettings;
    vpvrMode: VpvrMode;
    paneOrder: ChartPaneId[];
    paneCollapsed: Record<ChartPaneId, boolean>;
    paneHeights: Record<ChartPaneId, number>;
    timeframe: Timeframe;
}

export const INDICATOR_IDS = C.indicators as readonly ChartIndicatorId[];
export const PANE_IDS = C.panes as readonly ChartPaneId[];

const isIndicator = (k: string): k is ChartIndicatorId => (INDICATOR_IDS as readonly string[]).includes(k);
const isPane = (k: string): k is ChartPaneId => (PANE_IDS as readonly string[]).includes(k);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function allIndicators(on: boolean): IndicatorToggles {
    return Object.fromEntries(INDICATOR_IDS.map((id) => [id, on])) as IndicatorToggles;
}

const MA = C.movingAverages;
const MA_ID = new RegExp(MA.idPattern);
const MA_COLOR = new RegExp(MA.colorPattern);

/**
 * The valid lines of a saved list, in order: bad entries and repeated ids are
 * dropped, lengths rounded and clamped, at most `maxLines`.
 */
export function sanitizeMovingAverages(raw: unknown): MovingAverageSpec[] {
    if (!Array.isArray(raw)) return [];
    const out: MovingAverageSpec[] = [];
    for (const m of raw) {
        if (out.length >= MA.maxLines) break;
        if (!isObj(m) || typeof m.id !== "string" || !MA_ID.test(m.id) || out.some((o) => o.id === m.id)) continue;
        if (!(MA.types as readonly string[]).includes(m.type as string)) continue;
        if (typeof m.length !== "number" || !Number.isFinite(m.length)) continue;
        if (typeof m.color !== "string" || !MA_COLOR.test(m.color)) continue;
        const length = Math.round(Math.max(MA.length.min, Math.min(MA.length.max, m.length)));
        out.push({ id: m.id, type: m.type as MovingAverageSpec["type"], length, color: m.color });
    }
    return out;
}

/** A cross on two different lines that exist, or null. */
export function sanitizeMaCross(raw: unknown, lines: MovingAverageSpec[]): MaCrossSpec | null {
    if (!isObj(raw) || typeof raw.fast !== "string" || typeof raw.slow !== "string" || raw.fast === raw.slow) return null;
    const has = (id: string) => lines.some((m) => m.id === id);
    return has(raw.fast) && has(raw.slow) ? { fast: raw.fast, slow: raw.slow } : null;
}

/** Settings from a config's `params` (unmentioned → none drawn). */
export function resolveSettings(params: unknown): IndicatorSettings {
    const p = isObj(params) ? params : {};
    const movingAverages = sanitizeMovingAverages(p.movingAverages);
    return { movingAverages, maCross: sanitizeMaCross(p.maCross, movingAverages) };
}

export function settingsEqual(a: IndicatorSettings, b: IndicatorSettings): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
}

/** Today's pane order with `first` moved to the front (in that order). */
export function orderWithFirst(first: ChartPaneId[]): ChartPaneId[] {
    return [...first, ...PANE_IDS.filter((p) => !first.includes(p))];
}

/**
 * Resolve a saved (or preset) config against the current state. Never throws:
 * a config written by an older/newer build applies as far as it makes sense.
 */
export function resolveConfig(raw: unknown, current: ChartState): ChartState {
    const upgraded = upgradeLegacyEmaConfig(raw);
    const cfg = isObj(upgraded) ? upgraded : {};

    const indicators = allIndicators(false);
    if (isObj(cfg.indicators)) {
        for (const [k, v] of Object.entries(cfg.indicators)) {
            if (isIndicator(k) && v === true) indicators[k] = true;
        }
    }

    const params = isObj(cfg.params) ? cfg.params : {};
    const settings = resolveSettings(params);
    const vpvr = isObj(params.vpvr) ? params.vpvr : {};
    const vpvrMode = (C.params.vpvr.mode as readonly string[]).includes(vpvr.mode as string)
        ? (vpvr.mode as VpvrMode)
        : current.vpvrMode;

    const panes = isObj(cfg.panes) ? cfg.panes : {};
    let paneOrder = current.paneOrder;
    if (Array.isArray(panes.order)) {
        const named: ChartPaneId[] = [];
        for (const p of panes.order) if (typeof p === "string" && isPane(p) && !named.includes(p)) named.push(p);
        paneOrder = orderWithFirst(named);
    }

    const paneCollapsed = { ...current.paneCollapsed };
    if (isObj(panes.collapsed)) {
        for (const [k, v] of Object.entries(panes.collapsed)) if (isPane(k) && typeof v === "boolean") paneCollapsed[k] = v;
    }

    const paneHeights = { ...current.paneHeights };
    if (isObj(panes.heights)) {
        for (const [k, v] of Object.entries(panes.heights)) {
            if (isPane(k) && typeof v === "number" && Number.isFinite(v)) {
                paneHeights[k] = Math.round(Math.max(C.paneHeight.min, Math.min(C.paneHeight.max, v)));
            }
        }
    }

    const timeframe = (C.timeframes as readonly string[]).includes(cfg.timeframe as string)
        ? (cfg.timeframe as Timeframe)
        : current.timeframe;

    return { indicators, settings, vpvrMode, paneOrder, paneCollapsed, paneHeights, timeframe };
}

/** Full config for "Save current as…" / "Update": owns every field. */
export function captureConfig(s: ChartState): ChartLayoutConfig {
    const on = Object.fromEntries(INDICATOR_IDS.filter((id) => s.indicators[id]).map((id) => [id, true]));
    return {
        version: 1,
        indicators: on,
        params: {
            vpvr: { mode: s.vpvrMode },
            rsi: { period: 14 },
            atr: { period: 14 },
            macd: { fast: 12, slow: 26, signal: 9 },
            bollingerBands: { period: 20, stdDev: 2 },
            movingAverages: s.settings.movingAverages.map((m) => ({ ...m })),
            ...(s.settings.maCross ? { maCross: { ...s.settings.maCross } } : {}),
        },
        panes: {
            order: [...s.paneOrder],
            collapsed: { ...s.paneCollapsed },
            heights: Object.fromEntries(PANE_IDS.map((p) => [p, Math.round(s.paneHeights[p])])),
        },
        timeframe: s.timeframe as ChartLayoutConfig["timeframe"],
    };
}

export function statesEqual(a: ChartState, b: ChartState): boolean {
    return (
        a.vpvrMode === b.vpvrMode &&
        a.timeframe === b.timeframe &&
        settingsEqual(a.settings, b.settings) &&
        INDICATOR_IDS.every((id) => a.indicators[id] === b.indicators[id]) &&
        PANE_IDS.every((p, i) =>
            a.paneOrder[i] === b.paneOrder[i] &&
            a.paneCollapsed[p] === b.paneCollapsed[p] &&
            a.paneHeights[p] === b.paneHeights[p])
    );
}

/**
 * The "modified" dot: does the chart still match the active layout? The
 * layout is re-resolved against the current state, so fields it doesn't name
 * (a preset doesn't name the timeframe) never count as a change.
 */
export function isModified(activeConfig: unknown, current: ChartState): boolean {
    return !statesEqual(resolveConfig(activeConfig, current), current);
}

// ── Built-in presets (read-only) ───────────────────────────────────────────

export interface Preset {
    id: `preset:${string}`;
    name: string;
    config: ChartLayoutConfig;
}

const SWING_PANES: ChartPaneId[] = ["rsi", "atr", "volume"];

/** The old EMA 20/50/200 toggles as lines (ids = the old keys), crossing on 50/200. */
const LEGACY_EMAS = (upgradeLegacyEmaConfig<unknown>({
    version: 1,
    indicators: { ema20: true, ema50: true, ema200: true },
}) as ChartLayoutConfig).params!;

export const PRESETS: Preset[] = [
    {
        id: "preset:swing",
        name: "Swing",
        // EMA 20/50/200 (the lines this preset has always drawn). VPVR draws
        // POC + VAH/VAL together.
        config: {
            version: 1,
            indicators: { keyLevels: true, vpvr: true, rsi: true, atr: true, volume: true },
            params: { vpvr: { mode: "visible" }, rsi: { period: 14 }, atr: { period: 14 }, ...LEGACY_EMAS },
            panes: {
                order: orderWithFirst(SWING_PANES),
                collapsed: { rsi: false, atr: false, volume: false },
            },
        },
    },
    {
        id: "preset:everything",
        name: "Everything",
        config: { version: 1, indicators: allIndicators(true), params: { ...LEGACY_EMAS } },
    },
    {
        id: "preset:clean",
        name: "Clean",
        config: { version: 1, indicators: {} },
    },
];

export const isPresetId = (id: string | null): id is Preset["id"] => !!id && id.startsWith("preset:");
