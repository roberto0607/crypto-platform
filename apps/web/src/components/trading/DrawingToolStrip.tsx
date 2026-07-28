import { useDrawingStore, DRAWING_TOOL_ORDER, DRAWING_TOOL_SPECS, DRAWING_COLOR_PALETTE } from "@/stores/drawingStore";
import { DrawingToolIcon, MeasureIcon, MagnetIcon, ClearAllIcon } from "./DrawingToolIcons";

/**
 * Small fixed-palette swatch grid — shown in TWO contexts (never both at
 * once, since setActiveTool clears selectedDrawingId and vice versa, so the
 * two states are mutually exclusive by construction):
 *   - a persistable tool is active (not Measure, which never has a color) →
 *     picking a swatch sets `nextColor`, applied to the NEXT commit only
 *   - a drawing is selected → picking a swatch recolors it immediately
 * `activeColor` highlights the current choice (nextColor, or the selected
 * drawing's own color) so the picker shows what's already in effect.
 */
function ColorSwatchGrid({
    activeColor,
    onSelect,
}: {
    activeColor: string | null;
    onSelect: (color: string) => void;
}) {
    return (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 3, padding: "4px 0" }}>
            {DRAWING_COLOR_PALETTE.map((color) => (
                <button
                    key={color}
                    type="button"
                    title={color}
                    onClick={() => onSelect(color)}
                    style={{
                        width: 13, height: 13, borderRadius: "50%", padding: 0,
                        background: color,
                        border: activeColor === color ? "2px solid #fff" : "1px solid rgba(255,255,255,0.25)",
                        cursor: "pointer",
                    }}
                />
            ))}
        </div>
    );
}

/**
 * Left-edge vertical icon strip for the in-scope drawing tools — mirrors
 * TradingView's own layout convention (a dedicated rail along the chart
 * canvas's left edge, not the top toolbar). Rendered as a flex sibling of
 * the chart container (see CandlestickChart.tsx's wrapping div), so it
 * takes real layout width and the chart's plot area shrinks to fit — not
 * an absolute overlay competing with the top-left legend-chip stack.
 *
 * Below a divider: non-tool toggles/actions (Magnet snap, Clear-all) that
 * affect drawings globally rather than selecting a placement tool.
 */
export function DrawingToolStrip() {
    const activeTool = useDrawingStore((s) => s.activeTool);
    const setActiveTool = useDrawingStore((s) => s.setActiveTool);
    const snapEnabled = useDrawingStore((s) => s.snapEnabled);
    const toggleSnap = useDrawingStore((s) => s.toggleSnap);
    const nextColor = useDrawingStore((s) => s.nextColor);
    const setNextColor = useDrawingStore((s) => s.setNextColor);
    const selectedDrawingId = useDrawingStore((s) => s.selectedDrawingId);
    const drawings = useDrawingStore((s) => s.drawings);
    const setDrawingColor = useDrawingStore((s) => s.setDrawingColor);
    const clearAllForPair = useDrawingStore((s) => s.clearAllForPair);

    const selectedDrawing = selectedDrawingId ? drawings.find((d) => d.id === selectedDrawingId) : null;
    const showColorPicker = (!!activeTool && activeTool !== "measure") || !!selectedDrawing;

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

            {showColorPicker && (
                <ColorSwatchGrid
                    activeColor={selectedDrawing ? selectedDrawing.color : nextColor}
                    onSelect={(color) => {
                        if (selectedDrawing) setDrawingColor(selectedDrawing.id, color);
                        else setNextColor(color);
                    }}
                />
            )}

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

            <button
                type="button"
                title="Clear all drawings"
                onClick={() => {
                    if (window.confirm("Clear all drawings on this chart?")) clearAllForPair();
                }}
                style={{
                    width: 28, height: 28, borderRadius: 2,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    background: "transparent", border: "1px solid transparent",
                    color: "rgba(255,255,255,0.85)",
                    cursor: "pointer", transition: "all 0.15s",
                }}
            >
                <ClearAllIcon />
            </button>
        </div>
    );
}
