import { create } from "zustand";

// Chart drawing tools (Gate 1, first pass — 6 tools). See
// docs/designs/2026-07-26-chart-drawing-tools-gate1.md for the full design.
// Fibonacci Retracement was picked up as a fast-follow (Gate 1 addendum,
// 2026-07-27) — DRAWING_TOOL_SPECS' requiredPoints field is what made this a
// one-line addition instead of a state-machine rewrite, exactly as planned.
// Parallel Channel remains deferred.

export type DrawingToolType = "hline" | "hray" | "vline" | "text" | "trendline" | "rect" | "fib";

// Measure is deliberately NOT a DrawingToolType — it never persists a
// StoredDrawing (Gate 1 addendum: "transient, purely a measuring aid"), so
// it's excluded from DRAWING_TOOL_SPECS/DRAWING_TOOL_ORDER and from
// StoredDrawing["type"]'s exhaustiveness. It still needs to occupy
// `activeTool` (so it gets the same toolbar-button/pan-lock treatment as
// every other tool), hence this separate, wider union just for that field.
export type ActiveDrawingTool = DrawingToolType | "measure";

export interface DrawingPoint {
    time: number;
    price: number;
}

export interface StoredDrawing {
    id: string;
    type: DrawingToolType;
    points: DrawingPoint[];
    text?: string;
    color: string;
    createdAt: number;
}

interface DrawingToolSpec {
    type: DrawingToolType;
    label: string;
    requiredPoints: number;
    defaultColor: string;
}

export const DRAWING_TOOL_SPECS: Record<DrawingToolType, DrawingToolSpec> = {
    hline: { type: "hline", label: "Horizontal Line", requiredPoints: 1, defaultColor: "#f5b942" },
    hray: { type: "hray", label: "Horizontal Ray", requiredPoints: 1, defaultColor: "#f5b942" },
    vline: { type: "vline", label: "Vertical Line", requiredPoints: 1, defaultColor: "#818cff" },
    text: { type: "text", label: "Text Annotation", requiredPoints: 1, defaultColor: "#e5e7eb" },
    trendline: { type: "trendline", label: "Trend Line", requiredPoints: 2, defaultColor: "#00ff41" },
    rect: { type: "rect", label: "Rectangle", requiredPoints: 2, defaultColor: "#06b6d4" },
    fib: { type: "fib", label: "Fibonacci Retracement", requiredPoints: 2, defaultColor: "#c084fc" },
};

export const DRAWING_TOOL_ORDER: DrawingToolType[] = ["trendline", "fib", "hline", "hray", "vline", "rect", "text"];

// Small fixed palette (deliberately not a full color wheel) — the 5 existing
// per-tool defaults plus 3 more to round it out, all already dark-background-
// tuned by the precedent those 5 set.
export const DRAWING_COLOR_PALETTE: readonly string[] = [
    "#f5b942", // amber (hline/hray default)
    "#818cff", // indigo (vline default)
    "#00ff41", // green (trendline default)
    "#06b6d4", // cyan (rect default)
    "#c084fc", // violet (fib default)
    "#e5e7eb", // light gray (text default)
    "#ef4444", // red
    "#ffffff", // white
];

// Global version bump, matching INDICATOR_CONFIG_VERSION's convention exactly
// (resolved decision, 2026-07-26 design-lock addendum): a bump wipes every
// pair's stored drawings, not just one.
const DRAWINGS_VERSION_KEY = "tradr_drawings_version";
const DRAWINGS_SCHEMA_VERSION = 1;
const DRAWINGS_KEY_PREFIX = "tradr_drawings_";

function drawingsKeyForPair(pairId: string): string {
    return `${DRAWINGS_KEY_PREFIX}${pairId}`;
}

function ensureDrawingsVersion(): void {
    try {
        const storedVersion = localStorage.getItem(DRAWINGS_VERSION_KEY);
        if (!storedVersion || parseInt(storedVersion, 10) < DRAWINGS_SCHEMA_VERSION) {
            for (let i = localStorage.length - 1; i >= 0; i--) {
                const key = localStorage.key(i);
                if (key && key.startsWith(DRAWINGS_KEY_PREFIX) && key !== DRAWINGS_VERSION_KEY) {
                    localStorage.removeItem(key);
                }
            }
            localStorage.setItem(DRAWINGS_VERSION_KEY, String(DRAWINGS_SCHEMA_VERSION));
        }
    } catch { /* ignore */ }
}

function loadDrawingsForPair(pairId: string): StoredDrawing[] {
    ensureDrawingsVersion();
    try {
        const stored = localStorage.getItem(drawingsKeyForPair(pairId));
        if (!stored) return [];
        const parsed = JSON.parse(stored);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function saveDrawingsForPair(pairId: string, drawings: StoredDrawing[]): void {
    try {
        localStorage.setItem(drawingsKeyForPair(pairId), JSON.stringify(drawings));
    } catch { /* ignore */ }
}

function genId(): string {
    return `dr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// Magnet/snap-to-candle — a standalone session preference (not per-pair, not
// versioned with the drawings schema), so it gets its own key rather than
// living inside the per-pair blob. Deliberately does NOT start with
// DRAWINGS_KEY_PREFIX ("tradr_drawings_") — that prefix is also what
// ensureDrawingsVersion's stale-version wipe loop matches against, so a key
// starting with it would get silently deleted on every schema bump.
const SNAP_STORAGE_KEY = "tradr_snap_enabled";

function loadSnapPreference(): boolean {
    try {
        return localStorage.getItem(SNAP_STORAGE_KEY) === "1";
    } catch {
        return false;
    }
}

function saveSnapPreference(enabled: boolean): void {
    try {
        localStorage.setItem(SNAP_STORAGE_KEY, enabled ? "1" : "0");
    } catch { /* ignore */ }
}

interface DraggingAnchor {
    drawingId: string;
    anchorIndex: number;
}

interface DrawingState {
    currentPairId: string | null;
    drawings: StoredDrawing[];
    activeTool: ActiveDrawingTool | null;
    pendingPoints: DrawingPoint[];
    selectedDrawingId: string | null;
    draggingAnchor: DraggingAnchor | null;
    snapEnabled: boolean;
    // Color swatch picked for the NEXT commit while a tool is active — null
    // means "use that tool's spec.defaultColor". Single-shot: cleared on
    // commit and on every setActiveTool call (a color picked for one tool
    // shouldn't silently carry over to a different tool picked afterward).
    nextColor: string | null;

    loadForPair: (pairId: string) => void;
    setActiveTool: (tool: ActiveDrawingTool | null) => void;
    setNextColor: (color: string | null) => void;
    toggleSnap: () => void;
    addPoint: (point: DrawingPoint) => void;
    cancelPlacement: () => void;
    selectDrawing: (id: string | null) => void;
    setDrawingText: (id: string, text: string) => void;
    setDrawingColor: (id: string, color: string) => void;
    startDraggingAnchor: (drawingId: string, anchorIndex: number) => void;
    updateDraggingAnchor: (point: DrawingPoint) => void;
    commitDraggingAnchor: () => void;
    deleteDrawing: (id: string) => void;
    deleteSelected: () => void;
    clearAllForPair: () => void;
}

export const useDrawingStore = create<DrawingState>((set, get) => ({
    currentPairId: null,
    drawings: [],
    activeTool: null,
    pendingPoints: [],
    selectedDrawingId: null,
    draggingAnchor: null,
    snapEnabled: loadSnapPreference(),
    nextColor: null,

    setNextColor: (color) => set({ nextColor: color }),

    toggleSnap: () => {
        const next = !get().snapEnabled;
        saveSnapPreference(next);
        set({ snapEnabled: next });
    },

    // No-ops if already loaded for this pair — keeps a redundant call (e.g.
    // from a re-render) from clobbering in-progress tool/selection state.
    loadForPair: (pairId) => {
        if (get().currentPairId === pairId) return;
        set({
            currentPairId: pairId,
            drawings: loadDrawingsForPair(pairId),
            activeTool: null,
            pendingPoints: [],
            selectedDrawingId: null,
            draggingAnchor: null,
        });
    },

    setActiveTool: (tool) => {
        set({ activeTool: tool, pendingPoints: [], selectedDrawingId: null, nextColor: null });
    },

    addPoint: (point) => {
        const { activeTool, pendingPoints, currentPairId, drawings, nextColor } = get();
        // Measure never commits a StoredDrawing — CandlestickChart.tsx routes
        // its whole gesture through a separate raw mousedown/move/up path and
        // should never call addPoint while activeTool is "measure", but this
        // guard is what narrows ActiveDrawingTool back to DrawingToolType for
        // the DRAWING_TOOL_SPECS lookup below either way.
        if (!activeTool || activeTool === "measure" || !currentPairId) return;
        const spec = DRAWING_TOOL_SPECS[activeTool];
        const nextPoints = [...pendingPoints, point];

        if (nextPoints.length < spec.requiredPoints) {
            set({ pendingPoints: nextPoints });
            return;
        }

        const drawing: StoredDrawing = {
            id: genId(),
            type: activeTool,
            points: nextPoints,
            color: nextColor ?? spec.defaultColor,
            createdAt: Date.now(),
            ...(activeTool === "text" ? { text: "" } : {}),
        };
        const next = [...drawings, drawing];
        saveDrawingsForPair(currentPairId, next);
        // Tool auto-deselects on commit; the new drawing enters selected state.
        // nextColor is single-shot — consumed here, not carried into whatever
        // tool gets activated next.
        set({
            drawings: next,
            activeTool: null,
            pendingPoints: [],
            selectedDrawingId: drawing.id,
            nextColor: null,
        });
    },

    cancelPlacement: () => {
        set({ activeTool: null, pendingPoints: [] });
    },

    selectDrawing: (id) => set({ selectedDrawingId: id }),

    setDrawingText: (id, text) => {
        const { currentPairId, drawings } = get();
        if (!currentPairId) return;
        const next = drawings.map((d) => (d.id === id ? { ...d, text } : d));
        saveDrawingsForPair(currentPairId, next);
        set({ drawings: next });
    },

    setDrawingColor: (id, color) => {
        const { currentPairId, drawings } = get();
        if (!currentPairId) return;
        const next = drawings.map((d) => (d.id === id ? { ...d, color } : d));
        saveDrawingsForPair(currentPairId, next);
        set({ drawings: next });
    },

    startDraggingAnchor: (drawingId, anchorIndex) => {
        set({ draggingAnchor: { drawingId, anchorIndex } });
    },

    // Live drag updates in-memory only — persisted once on commitDraggingAnchor
    // (mouseup), not on every intermediate move.
    updateDraggingAnchor: (point) => {
        const { draggingAnchor, drawings } = get();
        if (!draggingAnchor) return;
        const next = drawings.map((d) => {
            if (d.id !== draggingAnchor.drawingId) return d;
            const points = [...d.points];
            points[draggingAnchor.anchorIndex] = point;
            return { ...d, points };
        });
        set({ drawings: next });
    },

    commitDraggingAnchor: () => {
        const { currentPairId, drawings, draggingAnchor } = get();
        if (!draggingAnchor || !currentPairId) return;
        saveDrawingsForPair(currentPairId, drawings);
        set({ draggingAnchor: null });
    },

    deleteDrawing: (id) => {
        const { currentPairId, drawings, selectedDrawingId } = get();
        if (!currentPairId) return;
        const next = drawings.filter((d) => d.id !== id);
        saveDrawingsForPair(currentPairId, next);
        set({
            drawings: next,
            selectedDrawingId: selectedDrawingId === id ? null : selectedDrawingId,
        });
    },

    deleteSelected: () => {
        const { selectedDrawingId, deleteDrawing } = get();
        if (selectedDrawingId) deleteDrawing(selectedDrawingId);
    },

    // Current-pair-only, matching the per-pair persistence key — clearing
    // BTC's drawings never touches ETH's. Confirm() gate lives in the UI
    // layer (DrawingToolStrip), not here, matching how other destructive
    // confirms in this codebase (ConversationView.tsx's report-message) are
    // UI-layer concerns, not store concerns.
    clearAllForPair: () => {
        const { currentPairId } = get();
        if (!currentPairId) return;
        saveDrawingsForPair(currentPairId, []);
        set({
            drawings: [],
            selectedDrawingId: null,
            pendingPoints: [],
            activeTool: null,
            draggingAnchor: null,
            nextColor: null,
        });
    },
}));
