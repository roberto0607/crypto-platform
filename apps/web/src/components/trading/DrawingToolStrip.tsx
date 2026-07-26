import { useDrawingStore, DRAWING_TOOL_ORDER, DRAWING_TOOL_SPECS } from "@/stores/drawingStore";
import { DrawingToolIcon } from "./DrawingToolIcons";

/**
 * Left-edge vertical icon strip for the 6 in-scope drawing tools — mirrors
 * TradingView's own layout convention (a dedicated rail along the chart
 * canvas's left edge, not the top toolbar). Rendered as a flex sibling of
 * the chart container (see CandlestickChart.tsx's wrapping div), so it
 * takes real layout width and the chart's plot area shrinks to fit — not
 * an absolute overlay competing with the top-left legend-chip stack.
 */
export function DrawingToolStrip() {
    const activeTool = useDrawingStore((s) => s.activeTool);
    const setActiveTool = useDrawingStore((s) => s.setActiveTool);

    return (
        <div
            style={{
                width: 36, flexShrink: 0,
                display: "flex", flexDirection: "column", alignItems: "center",
                gap: 2, paddingTop: 6,
                borderRight: "1px solid rgba(255,255,255,0.08)",
                background: "rgba(4,4,4,0.6)",
            }}
        >
            {DRAWING_TOOL_ORDER.map((type) => {
                const spec = DRAWING_TOOL_SPECS[type];
                const active = activeTool === type;
                return (
                    <button
                        key={type}
                        type="button"
                        title={spec.label}
                        onClick={() => setActiveTool(active ? null : type)}
                        style={{
                            width: 28, height: 28, borderRadius: 2,
                            display: "flex", alignItems: "center", justifyContent: "center",
                            background: active ? "#00ff41" : "transparent",
                            border: active ? "1px solid #00ff41" : "1px solid transparent",
                            color: active ? "#000" : "rgba(255,255,255,0.85)",
                            cursor: "pointer", transition: "all 0.15s",
                        }}
                    >
                        <DrawingToolIcon type={type} />
                    </button>
                );
            })}
        </div>
    );
}
