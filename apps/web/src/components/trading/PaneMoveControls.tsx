import { createContext, useContext } from "react";
import type { ChartPaneId } from "@/lib/chartLayouts/catalog";
import { useChartLayoutStore } from "@/stores/chartLayoutStore";

/**
 * Pane reordering. CandlestickChart wraps each visible sub-pane in a
 * provider; SubPanelHeader renders ▲/▼ when it finds one, so the nine panel
 * components need no new props.
 */
export interface PaneMoveInfo {
    pane: ChartPaneId;
    /** Panes currently shown, in order — a move jumps over hidden ones. */
    visible: ChartPaneId[];
}

export const PaneMoveContext = createContext<PaneMoveInfo | null>(null);

const btn: React.CSSProperties = {
    background: "transparent", border: "none", padding: "0 3px", cursor: "pointer",
    fontSize: 8, lineHeight: "16px", color: "rgba(255,255,255,0.35)",
};

export function PaneMoveButtons() {
    const info = useContext(PaneMoveContext);
    const movePane = useChartLayoutStore((s) => s.movePane);
    if (!info) return null;
    const i = info.visible.indexOf(info.pane);
    const canUp = i > 0;
    const canDown = i >= 0 && i < info.visible.length - 1;
    if (!canUp && !canDown) return null;
    const move = (dir: -1 | 1) => (e: React.MouseEvent) => {
        e.stopPropagation(); // the header's own click toggles collapse
        movePane(info.pane, dir, info.visible);
    };
    return (
        <span style={{ display: "inline-flex" }} data-testid={`pane-move-${info.pane}`}>
            {canUp && (
                <button type="button" style={btn} onClick={move(-1)} title="Move pane up" aria-label={`Move ${info.pane} pane up`}>▲</button>
            )}
            {canDown && (
                <button type="button" style={btn} onClick={move(1)} title="Move pane down" aria-label={`Move ${info.pane} pane down`}>▼</button>
            )}
        </span>
    );
}
