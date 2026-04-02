import { useRef, useCallback } from "react";

const STORAGE_KEY = "tradr_panel_heights";

export const DEFAULT_HEIGHTS: Record<string, number> = {
    volume: 80,
    macd: 100,
    rsi: 80,
    atr: 120,
    delta: 80,
    cvd: 60,
};

const MIN_HEIGHT = 40;
const MAX_HEIGHT = 400;

export function loadPanelHeights(): Record<string, number> {
    try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored) {
            const parsed = JSON.parse(stored);
            const result: Record<string, number> = {};
            for (const [key, def] of Object.entries(DEFAULT_HEIGHTS)) {
                const val = typeof parsed[key] === "number" ? parsed[key] : def;
                result[key] = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, val));
            }
            return result;
        }
    } catch { /* ignore */ }
    return { ...DEFAULT_HEIGHTS };
}

function savePanelHeights(heights: Record<string, number>) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(heights)); } catch { /* ignore */ }
}

interface DragHandleProps {
    panelKey: string;
    currentHeight: number;
    onHeightChange: (key: string, height: number) => void;
    onDragEnd: (key: string, height: number) => void;
}

export function DragHandle({ panelKey, currentHeight, onHeightChange, onDragEnd }: DragHandleProps) {
    const dragRef = useRef<{ startY: number; startH: number } | null>(null);

    const onMouseDown = useCallback((e: React.MouseEvent) => {
        e.preventDefault();
        dragRef.current = { startY: e.clientY, startH: currentHeight };

        const onMouseMove = (ev: MouseEvent) => {
            if (!dragRef.current) return;
            const delta = ev.clientY - dragRef.current.startY;
            const newH = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, dragRef.current.startH + delta));
            onHeightChange(panelKey, newH);
        };

        const onMouseUp = (ev: MouseEvent) => {
            window.removeEventListener("mousemove", onMouseMove);
            window.removeEventListener("mouseup", onMouseUp);
            if (dragRef.current) {
                const delta = ev.clientY - dragRef.current.startY;
                const finalH = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, dragRef.current.startH + delta));
                dragRef.current = null;
                onDragEnd(panelKey, finalH);
            }
        };

        window.addEventListener("mousemove", onMouseMove);
        window.addEventListener("mouseup", onMouseUp);
    }, [panelKey, currentHeight, onHeightChange, onDragEnd]);

    return (
        <div
            onMouseDown={onMouseDown}
            style={{
                height: 6, cursor: "ns-resize", background: "#1a1a1a",
                display: "flex", alignItems: "center", justifyContent: "center",
                transition: "background 0.1s",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = "#2a2a2a"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "#1a1a1a"; }}
        >
            <div style={{ width: 24, height: 2, background: "#444", borderRadius: 1 }} />
        </div>
    );
}

export { savePanelHeights };
