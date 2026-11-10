import { useEffect, useState } from "react";
import { CHART_LAYOUT_CATALOG, type MovingAverageSpec } from "@/lib/chartLayouts/catalog";
import { useIndicatorSettingsStore } from "@/stores/indicatorSettingsStore";

const MA = CHART_LAYOUT_CATALOG.movingAverages;
const FONT = "'Space Mono', monospace";

const control: React.CSSProperties = {
    height: 22, boxSizing: "border-box", fontFamily: FONT, fontSize: 10,
    background: "rgba(255,255,255,0.04)", color: "rgba(255,255,255,0.85)",
    border: "1px solid rgba(255,255,255,0.12)", borderRadius: 2, outline: "none",
};

/** Typed length; only a whole number in range reaches the store, blur restores it. */
function LengthInput({ line }: { line: MovingAverageSpec }) {
    const update = useIndicatorSettingsStore((s) => s.updateMovingAverage);
    const [draft, setDraft] = useState(String(line.length));
    useEffect(() => setDraft(String(line.length)), [line.length]);
    return (
        <input
            aria-label="Length"
            type="number"
            inputMode="numeric"
            min={MA.length.min}
            max={MA.length.max}
            value={draft}
            onChange={(e) => {
                setDraft(e.target.value);
                const n = Number(e.target.value);
                if (e.target.value !== "" && Number.isInteger(n) && n >= MA.length.min) update(line.id, { length: n });
            }}
            onBlur={() => setDraft(String(line.length))}
            style={{ ...control, width: 52, padding: "0 4px" }}
        />
    );
}

/**
 * The moving-average lines (any number up to the catalog max), each with
 * type, length and color, plus golden/death-cross markers on two of them.
 */
export function MovingAveragesEditor() {
    const lines = useIndicatorSettingsStore((s) => s.movingAverages);
    const cross = useIndicatorSettingsStore((s) => s.maCross);
    const add = useIndicatorSettingsStore((s) => s.addMovingAverage);
    const update = useIndicatorSettingsStore((s) => s.updateMovingAverage);
    const remove = useIndicatorSettingsStore((s) => s.removeMovingAverage);
    const setCross = useIndicatorSettingsStore((s) => s.setMaCross);
    const label = (m: MovingAverageSpec) => `${m.type} ${m.length}`;

    function pickFast(id: string) {
        if (!id) return setCross(null);
        const others = lines.filter((m) => m.id !== id);
        const keep = cross && cross.slow !== id ? others.find((m) => m.id === cross.slow) : undefined;
        const slow = keep ?? [...others].sort((a, b) => b.length - a.length)[0];
        if (slow) setCross({ fast: id, slow: slow.id });
    }

    return (
        <div style={{ padding: "2px 12px 6px 34px", display: "flex", flexDirection: "column", gap: 4 }} onClick={(e) => e.stopPropagation()}>
            {lines.map((m) => (
                <div key={m.id} data-testid={`ma-row-${m.id}`} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <select
                        aria-label="Type"
                        value={m.type}
                        onChange={(e) => update(m.id, { type: e.target.value as MovingAverageSpec["type"] })}
                        style={{ ...control, width: 52 }}
                    >
                        {MA.types.map((t) => <option key={t} value={t}>{t}</option>)}
                    </select>
                    <LengthInput line={m} />
                    <input
                        aria-label="Color"
                        type="color"
                        value={m.color}
                        onInput={(e) => update(m.id, { color: (e.target as HTMLInputElement).value })}
                        onChange={(e) => update(m.id, { color: e.target.value })}
                        style={{ ...control, width: 26, padding: 1, cursor: "pointer" }}
                    />
                    <button
                        aria-label="Remove"
                        onClick={() => remove(m.id)}
                        style={{ ...control, width: 22, cursor: "pointer", color: "rgba(255,255,255,0.5)" }}
                    >
                        ×
                    </button>
                </div>
            ))}
            {lines.length < MA.maxLines && (
                <button
                    aria-label="Add moving average"
                    onClick={add}
                    style={{ ...control, alignSelf: "flex-start", padding: "0 8px", cursor: "pointer", color: "#00ff41", letterSpacing: 1 }}
                >
                    + ADD LINE
                </button>
            )}
            {lines.length >= 2 && (
                <div style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 2 }}>
                    <span style={{ fontFamily: FONT, fontSize: 9, letterSpacing: 1, color: "rgba(255,255,255,0.35)" }}>CROSS</span>
                    <select aria-label="Cross fast line" value={cross?.fast ?? ""} onChange={(e) => pickFast(e.target.value)} style={{ ...control, width: 74 }}>
                        <option value="">Off</option>
                        {lines.map((m) => <option key={m.id} value={m.id}>{label(m)}</option>)}
                    </select>
                    <span style={{ fontFamily: FONT, fontSize: 9, color: "rgba(255,255,255,0.35)" }}>×</span>
                    <select
                        aria-label="Cross slow line"
                        value={cross?.slow ?? ""}
                        disabled={!cross}
                        onChange={(e) => cross && setCross({ fast: cross.fast, slow: e.target.value })}
                        style={{ ...control, width: 74, opacity: cross ? 1 : 0.4 }}
                    >
                        {!cross && <option value="">—</option>}
                        {lines.filter((m) => m.id !== cross?.fast).map((m) => <option key={m.id} value={m.id}>{label(m)}</option>)}
                    </select>
                </div>
            )}
        </div>
    );
}
