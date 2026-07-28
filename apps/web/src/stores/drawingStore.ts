import { create } from "zustand";

// Chart drawing tools (Gate 1, first pass — 6 tools). See
// docs/designs/2026-07-26-chart-drawing-tools-gate1.md for the full design.
// Fibonacci Retracement was picked up as a fast-follow (Gate 1 addendum,
// 2026-07-27) — DRAWING_TOOL_SPECS' requiredPoints field is what made this a
// one-line addition instead of a state-machine rewrite, exactly as planned.
// Parallel Channel remains deferred.

export type DrawingToolType = "hline" | "hray" | "vline" | "text" | "trendline" | "rect" | "fib";

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
    activeTool: DrawingToolType | null;
    pendingPoints: DrawingPoint[];
    selectedDrawingId: string | null;
    draggingAnchor: DraggingAnchor | null;
    snapEnabled: boolean;

    loadForPair: (pairId: string) => void;
    setActiveTool: (tool: DrawingToolType | null) => void;
    toggleSnap: () => void;
    addPoint: (point: DrawingPoint) => void;
    cancelPlacement: () => void;
    selectDrawing: (id: string | null) => void;
    setDrawingText: (id: string, text: string) => void;
    startDraggingAnchor: (drawingId: string, anchorIndex: number) => void;
    updateDraggingAnchor: (point: DrawingPoint) => void;
    commitDraggingAnchor: () => void;
    deleteDrawing: (id: string) => void;
    deleteSelected: () => void;
}

export const useDrawingStore = create<DrawingState>((set, get) => ({
    currentPairId: null,
    drawings: [],
    activeTool: null,
    pendingPoints: [],
    selectedDrawingId: null,
    draggingAnchor: null,
    snapEnabled: loadSnapPreference(),

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
        set({ activeTool: tool, pendingPoints: [], selectedDrawingId: null });
    },

    addPoint: (point) => {
        const { activeTool, pendingPoints, currentPairId, drawings } = get();
        if (!activeTool || !currentPairId) return;
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
            color: spec.defaultColor,
            createdAt: Date.now(),
            ...(activeTool === "text" ? { text: "" } : {}),
        };
        const next = [...drawings, drawing];
        saveDrawingsForPair(currentPairId, next);
        // Tool auto-deselects on commit; the new drawing enters selected state.
        set({
            drawings: next,
            activeTool: null,
            pendingPoints: [],
            selectedDrawingId: drawing.id,
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
}));
