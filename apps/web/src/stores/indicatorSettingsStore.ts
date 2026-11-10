/**
 * Indicator settings beyond the on/off toggles (those stay in
 * tradingStore.indicatorConfig): the moving-average lines and which two of
 * them get golden/death-cross markers. Persisted to localStorage like the
 * toggles; chart layouts save and apply them (chartLayoutStore).
 *
 * First load after the moving-average list shipped: the old ema20/ema50/
 * ema200 toggles in localStorage `indicator-config` become the same EMA lines
 * (upgradeLegacyEmaConfig, the conversion saved layouts get too), so the chart
 * looks exactly as it did.
 */
import { create } from "zustand";
import { CHART_LAYOUT_CATALOG, upgradeLegacyEmaConfig, type MaCrossSpec, type MovingAverageSpec } from "@/lib/chartLayouts/catalog";
import {
    DEFAULT_INDICATOR_SETTINGS,
    resolveSettings,
    type IndicatorSettings,
} from "@/lib/chartLayouts/layoutConfig";

export const INDICATOR_SETTINGS_KEY = "indicator-settings";
/** tradingStore's toggles key — read once, for the old EMA toggles. */
const LEGACY_TOGGLES_KEY = "indicator-config";

/** Swatches offered for a line (the first three are the old EMA 20/50/200 colors). */
export const MA_COLORS = ["#3b82f6", "#f59e0b", "#ef4444", "#22c55e", "#a855f7", "#06b6d4", "#ec4899", "#e5e7eb"] as const;
/** Lengths a new line starts with, first one not already drawn. */
const NEW_MA_LENGTHS = [20, 50, 200, 100, 9, 21];

function readJson(key: string): unknown {
    try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : null;
    } catch {
        return null;
    }
}

function persist(s: IndicatorSettings) {
    try {
        localStorage.setItem(INDICATOR_SETTINGS_KEY, JSON.stringify(s));
    } catch { /* storage full/blocked — the chart still works this session */ }
}

function hasKey(key: string): boolean {
    try {
        return localStorage.getItem(key) !== null;
    } catch {
        return false;
    }
}

export function loadIndicatorSettings(): IndicatorSettings {
    // Saved settings (even unreadable ones) mean the old toggles were already converted.
    if (hasKey(INDICATOR_SETTINGS_KEY)) return resolveSettings(readJson(INDICATOR_SETTINGS_KEY));

    const toggles = readJson(LEGACY_TOGGLES_KEY);
    const upgraded = upgradeLegacyEmaConfig({ version: 1, indicators: toggles ?? {} }) as { params?: unknown };
    const settings = resolveSettings(upgraded.params);
    // Write it now: tradingStore drops the old keys on its next save.
    persist(settings);
    return settings;
}

/** A new line: the next unused length and color, EMA. */
export function nextMovingAverage(lines: MovingAverageSpec[]): MovingAverageSpec {
    let n = 1;
    while (lines.some((m) => m.id === `ma${n}`)) n++;
    const length = NEW_MA_LENGTHS.find((l) => !lines.some((m) => m.length === l)) ?? 20;
    const color = MA_COLORS.find((c) => !lines.some((m) => m.color.toLowerCase() === c)) ?? MA_COLORS[0];
    return { id: `ma${n}`, type: "EMA", length, color };
}

interface IndicatorSettingsState extends IndicatorSettings {
    /** Add a line (no-op at the catalog's max). */
    addMovingAverage: () => void;
    updateMovingAverage: (id: string, patch: Partial<Omit<MovingAverageSpec, "id">>) => void;
    /** Removing a line also removes cross markers that use it. */
    removeMovingAverage: (id: string) => void;
    setMaCross: (cross: MaCrossSpec | null) => void;
    /** Replace everything (applying a chart layout). */
    setSettings: (s: IndicatorSettings) => void;
}

export const useIndicatorSettingsStore = create<IndicatorSettingsState>((set, get) => {
    // Every write goes through resolveSettings, so the store only ever holds
    // what a layout could save (clamped length, valid cross).
    const commit = (next: Partial<IndicatorSettings>) => {
        const cur = get();
        const s = resolveSettings({
            movingAverages: next.movingAverages ?? cur.movingAverages,
            maCross: "maCross" in next ? next.maCross : cur.maCross,
        });
        persist(s);
        set(s);
    };
    return {
        ...DEFAULT_INDICATOR_SETTINGS,
        ...loadIndicatorSettings(),
        addMovingAverage: () => {
            const lines = get().movingAverages;
            if (lines.length >= CHART_LAYOUT_CATALOG.movingAverages.maxLines) return;
            commit({ movingAverages: [...lines, nextMovingAverage(lines)] });
        },
        updateMovingAverage: (id, patch) =>
            commit({ movingAverages: get().movingAverages.map((m) => (m.id === id ? { ...m, ...patch, id } : m)) }),
        removeMovingAverage: (id) => commit({ movingAverages: get().movingAverages.filter((m) => m.id !== id) }),
        setMaCross: (maCross) => commit({ maCross }),
        setSettings: (s) => commit({ movingAverages: s.movingAverages, maCross: s.maCross }),
    };
});

/** The settings part of the store, as a plain object. */
export function currentIndicatorSettings(): IndicatorSettings {
    const { movingAverages, maCross } = useIndicatorSettingsStore.getState();
    return { movingAverages, maCross };
}
