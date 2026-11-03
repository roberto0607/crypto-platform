/**
 * Chart layout store — the chart state a layout controls that ISN'T the
 * indicator toggles (those stay in tradingStore.indicatorConfig), plus the
 * saved layouts and which one is active.
 *
 * With no saved default, every initial value here equals what the chart used
 * before layouts existed: timeframe 1h, VPVR "visible", panes in their fixed
 * order, every pane collapsed, heights from localStorage `tradr_panel_heights`.
 */
import { create } from "zustand";
import type { Timeframe } from "@/api/endpoints/candles";
import {
  listChartLayouts,
  createChartLayout,
  updateChartLayout,
  deleteChartLayout,
  type SavedChartLayout,
} from "@/api/endpoints/chartLayouts";
import { loadPanelHeights, savePanelHeights } from "@/components/trading/DragHandle";
import type { ChartLayoutConfig, ChartPaneId, VpvrMode } from "@/lib/chartLayouts/catalog";
import {
  PANE_IDS,
  PRESETS,
  captureConfig,
  isPresetId,
  resolveConfig,
  type ChartState,
  type IndicatorToggles,
} from "@/lib/chartLayouts/layoutConfig";
import { useTradingStore, type IndicatorConfig } from "./tradingStore";

/** COT has no entry in DragHandle's DEFAULT_HEIGHTS; the chart fell back to 120. */
const COT_DEFAULT_HEIGHT = 120;

function initialHeights(): Record<ChartPaneId, number> {
  return { cotReport: COT_DEFAULT_HEIGHT, ...loadPanelHeights() } as Record<ChartPaneId, number>;
}

const allCollapsed = () => Object.fromEntries(PANE_IDS.map((p) => [p, true])) as Record<ChartPaneId, boolean>;

function errorMessage(err: unknown): string {
  const data = (err as { response?: { data?: { message?: string } } })?.response?.data;
  return data?.message ?? (err as Error)?.message ?? "Request failed";
}

interface ChartLayoutStoreState {
  timeframe: Timeframe;
  vpvrMode: VpvrMode;
  paneOrder: ChartPaneId[];
  paneCollapsed: Record<ChartPaneId, boolean>;
  paneHeights: Record<ChartPaneId, number>;

  layouts: SavedChartLayout[];
  /** A saved layout id, a preset id ("preset:swing"), or null (no layout picked). */
  activeLayoutId: string | null;
  /** The default layout is applied once per page load, after the first fetch. */
  defaultChecked: boolean;

  setTimeframe: (tf: Timeframe) => void;
  setVpvrMode: (m: VpvrMode) => void;
  togglePaneCollapsed: (p: ChartPaneId) => void;
  /**
   * Move a pane one step up/down. With `visible`, it jumps over hidden panes:
   * it lands just past its nearest visible neighbour in that direction.
   */
  movePane: (p: ChartPaneId, dir: -1 | 1, visible?: ChartPaneId[]) => void;
  /** Live drag (not persisted). */
  setPaneHeight: (p: ChartPaneId, h: number) => void;
  /** Drag end: persisted to localStorage like before. */
  commitPaneHeight: (p: ChartPaneId, h: number) => void;

  /**
   * Leaving /trade: back to the values a fresh mount had before layouts
   * (timeframe/VPVR mode/pane collapse+order were component state). Heights
   * reload from localStorage. The default layout re-applies on the next load.
   */
  resetSession: () => void;
  loadLayouts: () => Promise<void>;
  applyLayout: (id: string) => void;
  saveAs: (name: string, opts?: { isDefault?: boolean }) => Promise<SavedChartLayout>;
  updateActive: () => Promise<void>;
  renameLayout: (id: string, name: string) => Promise<void>;
  deleteLayout: (id: string) => Promise<void>;
  setDefault: (id: string, isDefault: boolean) => Promise<void>;
}

/** The full current chart state (both stores). */
export function currentChartState(): ChartState {
  const s = useChartLayoutStore.getState();
  return {
    indicators: { ...(useTradingStore.getState().indicatorConfig as IndicatorToggles) },
    vpvrMode: s.vpvrMode,
    paneOrder: s.paneOrder,
    paneCollapsed: s.paneCollapsed,
    paneHeights: s.paneHeights,
    timeframe: s.timeframe,
  };
}

/** Config of a preset or saved layout, or null if the id is unknown. */
export function layoutConfigById(id: string | null): ChartLayoutConfig | null {
  if (!id) return null;
  if (isPresetId(id)) return PRESETS.find((p) => p.id === id)?.config ?? null;
  return useChartLayoutStore.getState().layouts.find((l) => l.id === id)?.config ?? null;
}

function applyState(next: ChartState) {
  useTradingStore.getState().setIndicatorConfig(next.indicators as IndicatorConfig);
  savePanelHeights(next.paneHeights);
  useChartLayoutStore.setState({
    vpvrMode: next.vpvrMode,
    paneOrder: next.paneOrder,
    paneCollapsed: next.paneCollapsed,
    paneHeights: next.paneHeights,
    timeframe: next.timeframe,
  });
}

export const useChartLayoutStore = create<ChartLayoutStoreState>((set, get) => ({
  timeframe: "1h",
  vpvrMode: "visible",
  paneOrder: [...PANE_IDS],
  paneCollapsed: allCollapsed(),
  paneHeights: initialHeights(),

  layouts: [],
  activeLayoutId: null,
  defaultChecked: false,

  setTimeframe: (timeframe) => set({ timeframe }),
  setVpvrMode: (vpvrMode) => set({ vpvrMode }),
  togglePaneCollapsed: (p) => set({ paneCollapsed: { ...get().paneCollapsed, [p]: !get().paneCollapsed[p] } }),
  movePane: (p, dir, visible) => {
    const order = get().paneOrder.filter((x) => x !== p);
    const from = get().paneOrder.indexOf(p);
    if (from < 0) return;
    // Neighbour to jump over: the next (visible) pane in `dir` from p's slot.
    let j = dir === -1 ? from - 1 : from; // index in `order` (p removed)
    while (j >= 0 && j < order.length && visible && !visible.includes(order[j]!)) j += dir;
    if (j < 0 || j >= order.length) return;
    order.splice(dir === -1 ? j : j + 1, 0, p);
    set({ paneOrder: order });
  },
  setPaneHeight: (p, h) => set({ paneHeights: { ...get().paneHeights, [p]: h } }),
  commitPaneHeight: (p, h) => {
    const paneHeights = { ...get().paneHeights, [p]: h };
    savePanelHeights(paneHeights);
    set({ paneHeights });
  },

  resetSession: () =>
    set({
      timeframe: "1h",
      vpvrMode: "visible",
      paneOrder: [...PANE_IDS],
      paneCollapsed: allCollapsed(),
      paneHeights: initialHeights(),
      activeLayoutId: null,
      defaultChecked: false,
    }),

  loadLayouts: async () => {
    let layouts: SavedChartLayout[];
    try {
      layouts = (await listChartLayouts()).data.layouts ?? [];
    } catch (err) {
      // No layouts available → today's chart, untouched.
      console.warn("[chartLayouts] list failed:", err);
      set({ defaultChecked: true });
      return;
    }
    const firstLoad = !get().defaultChecked;
    set({ layouts, defaultChecked: true });
    if (!firstLoad) return;
    const def = layouts.find((l) => l.is_default);
    if (def) get().applyLayout(def.id);
  },

  applyLayout: (id) => {
    const config = layoutConfigById(id);
    if (!config) return;
    applyState(resolveConfig(config, currentChartState()));
    set({ activeLayoutId: id });
  },

  saveAs: async (name, opts) => {
    try {
      const res = await createChartLayout({ name, config: captureConfig(currentChartState()), isDefault: opts?.isDefault });
      const created = res.data.layout;
      const others = get().layouts.map((l) => (created.is_default ? { ...l, is_default: false } : l));
      set({ layouts: [...others, created], activeLayoutId: created.id });
      return created;
    } catch (err) {
      throw new Error(errorMessage(err));
    }
  },

  updateActive: async () => {
    const id = get().activeLayoutId;
    if (!id || isPresetId(id)) return;
    try {
      const res = await updateChartLayout(id, { config: captureConfig(currentChartState()) });
      set({ layouts: get().layouts.map((l) => (l.id === id ? res.data.layout : l)) });
    } catch (err) {
      throw new Error(errorMessage(err));
    }
  },

  renameLayout: async (id, name) => {
    try {
      const res = await updateChartLayout(id, { name });
      set({ layouts: get().layouts.map((l) => (l.id === id ? res.data.layout : l)) });
    } catch (err) {
      throw new Error(errorMessage(err));
    }
  },

  deleteLayout: async (id) => {
    try {
      await deleteChartLayout(id);
    } catch (err) {
      throw new Error(errorMessage(err));
    }
    set({
      layouts: get().layouts.filter((l) => l.id !== id),
      // The chart keeps what it shows; it just isn't "a layout" any more.
      activeLayoutId: get().activeLayoutId === id ? null : get().activeLayoutId,
    });
  },

  setDefault: async (id, isDefault) => {
    try {
      const res = await updateChartLayout(id, { isDefault });
      set({
        layouts: get().layouts.map((l) =>
          l.id === id ? res.data.layout : isDefault ? { ...l, is_default: false } : l),
      });
    } catch (err) {
      throw new Error(errorMessage(err));
    }
  },
}));

// Turning a pane's indicator off resets its pane to collapsed, as unmounting
// the pane did when collapsed state lived inside each panel component.
useTradingStore.subscribe((s, prev) => {
  if (s.indicatorConfig === prev.indicatorConfig) return;
  const collapsed = useChartLayoutStore.getState().paneCollapsed;
  let next: Record<ChartPaneId, boolean> | null = null;
  for (const p of PANE_IDS) {
    const key = p as keyof IndicatorConfig;
    if (prev.indicatorConfig[key] && !s.indicatorConfig[key] && !collapsed[p]) {
      next = next ?? { ...collapsed };
      next[p] = true;
    }
  }
  if (next) useChartLayoutStore.setState({ paneCollapsed: next });
});

/** Collapsed state for one sub-pane, shaped like the useState it replaced. */
export function usePaneCollapsed(p: ChartPaneId): [boolean, (updater: (v: boolean) => boolean) => void] {
  const collapsed = useChartLayoutStore((s) => s.paneCollapsed[p]);
  const setCollapsed = (updater: (v: boolean) => boolean) => {
    const cur = useChartLayoutStore.getState().paneCollapsed;
    useChartLayoutStore.setState({ paneCollapsed: { ...cur, [p]: updater(cur[p]) } });
  };
  return [collapsed, setCollapsed];
}
