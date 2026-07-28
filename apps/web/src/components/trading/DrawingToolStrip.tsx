import { useDrawingStore, DRAWING_TOOL_ORDER, DRAWING_TOOL_SPECS } from "@/stores/drawingStore";
import { DrawingToolIcon, MeasureIcon, MagnetIcon } from "./DrawingToolIcons";

/**
 * Left-edge vertical icon strip for the in-scope drawing tools — mirrors
 * TradingView's own layout convention (a dedicated rail along the chart
 * canvas's left edge, not the top toolbar). Rendered as a flex sibling of
 * the chart container (see CandlestickChart.tsx's wrapping div), so it
 * takes real layout width and the chart's plot area shrinks to fit — not
 * an absolute overlay competing with the top-left legend-chip stack.
 *
 * Below a divider: non-tool toggles/actions (Magnet snap, and later Clear-all)
 * that affect drawings globally rather than selecting a placement tool.
 */
export function DrawingToolStrip() {
    const activeTool = useDrawingStore((s) => s.activeTool);
    const setActiveTool = useDrawingStore((s) => s.setActiveTool);
    const snapEnabled = useDrawingStore((s) => s.snapEnabled);
    const toggleSnap = useDrawingStore((s) => s.toggleSnap);

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

            <button
                type="button"
                title="Measure"
                onClick={() => setActiveTool(activeTool === "measure" ? null : "measure")}
                style={{
                    width: 28, height: 28, borderRadius: 2,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    background: activeTool === "measure" ? "#00ff41" : "transparent",
                    border: activeTool === "measure" ? "1px solid #00ff41" : "1px solid transparent",
                    color: activeTool === "measure" ? "#000" : "rgba(255,255,255,0.85)",
                    cursor: "pointer", transition: "all 0.15s",
                }}
            >
                <MeasureIcon />
            </button>

            <div style={{ width: 20, height: 1, background: "rgba(255,255,255,0.12)", margin: "4px 0" }} />

            <button
                type="button"
                title={`Magnet (snap to candle) — ${snapEnabled ? "on" : "off"}`}
                aria-pressed={snapEnabled}
                onClick={toggleSnap}
                style={{
                    width: 28, height: 28, borderRadius: 2,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    background: snapEnabled ? "#00ff41" : "transparent",
                    border: snapEnabled ? "1px solid #00ff41" : "1px solid transparent",
                    color: snapEnabled ? "#000" : "rgba(255,255,255,0.85)",
                    cursor: "pointer", transition: "all 0.15s",
                }}
            >
                <MagnetIcon />
            </button>
        </div>
    );
}
