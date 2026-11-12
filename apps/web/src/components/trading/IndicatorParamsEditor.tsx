import { useEffect, useState } from "react";
import { CHART_LAYOUT_CATALOG } from "@/lib/chartLayouts/catalog";
import { useIndicatorSettingsStore } from "@/stores/indicatorSettingsStore";

const FONT = "'Space Mono', monospace";
const P = CHART_LAYOUT_CATALOG.numericParams;

type Group = keyof typeof P;

/** The inputs each settings group shows, in order. */
const FIELDS: { [G in Group]: Array<{ key: keyof (typeof P)[G] & string; label: string; aria: string }> } = {
    adx: [
        { key: "diLength", label: "DI", aria: "ADX DI length" },
        { key: "adxSmoothing", label: "SMOOTH", aria: "ADX smoothing" },
        { key: "threshold", label: "LINE", aria: "ADX threshold" },
    ],
    utBot: [
        { key: "keyValue", label: "KEY", aria: "UT Bot key value" },
        { key: "atrPeriod", label: "ATR", aria: "UT Bot ATR period" },
    ],
    supportResistance: [
        { key: "left", label: "LEFT", aria: "S/R pivot bars left" },
        { key: "right", label: "RIGHT", aria: "S/R pivot bars right" },
        { key: "mergeAtr", label: "MERGE", aria: "S/R merge distance (× ATR)" },
        { key: "breakAtr", label: "BREAK", aria: "S/R break buffer (× ATR)" },
        { key: "maxZoneAtr", label: "ZONE", aria: "S/R max zone width (× ATR)" },
        { key: "volumeMult", label: "VOL×", aria: "S/R break volume multiple" },
        { key: "nearest", label: "SHOW", aria: "S/R levels shown each side" },
        { key: "maxAgeBars", label: "AGE", aria: "S/R max age (bars)" },
        { key: "htfLeft", label: "HTF L", aria: "S/R higher-timeframe pivot bars left" },
        { key: "htfRight", label: "HTF R", aria: "S/R higher-timeframe pivot bars right" },
    ],
};

/** A typed number; only a value in range reaches the store (which rounds it to the step). Blur restores it. */
function ParamInput<G extends Group>({ group, field, aria }: { group: G; field: string; aria: string }) {
    const value = useIndicatorSettingsStore((s) => (s[group] as unknown as Record<string, number>)[field]!);
    const setAdx = useIndicatorSettingsStore((s) => s.setAdx);
    const setUtBot = useIndicatorSettingsStore((s) => s.setUtBot);
    const setSupportResistance = useIndicatorSettingsStore((s) => s.setSupportResistance);
    const range = (P[group] as Record<string, { min: number; max: number; step: number }>)[field]!;
    const [draft, setDraft] = useState(String(value));
    useEffect(() => setDraft(String(value)), [value]);

    function commit(text: string) {
        setDraft(text);
        const n = Number(text);
        if (text.trim() === "" || !Number.isFinite(n) || n < range.min) return;
        const patch = { [field]: n };
        if (group === "adx") setAdx(patch);
        else if (group === "utBot") setUtBot(patch);
        else setSupportResistance(patch);
    }

    return (
        <input
            aria-label={aria}
            type="number"
            inputMode="decimal"
            min={range.min}
            max={range.max}
            step={range.step}
            value={draft}
            onChange={(e) => commit(e.target.value)}
            onBlur={() => setDraft(String(value))}
            style={{
                width: 48, height: 22, boxSizing: "border-box", padding: "0 4px",
                fontFamily: FONT, fontSize: 10,
                background: "rgba(255,255,255,0.04)", color: "rgba(255,255,255,0.85)",
                border: "1px solid rgba(255,255,255,0.12)", borderRadius: 2, outline: "none",
            }}
        />
    );
}

/** Inline settings under an indicator's menu row (ADX lengths + line, UT Bot key value + ATR period). */
export function IndicatorParamsEditor({ group }: { group: Group }) {
    return (
        <div
            style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, padding: "2px 12px 6px 34px" }}
            onClick={(e) => e.stopPropagation()}
        >
            {FIELDS[group].map((f) => (
                <label key={f.key} style={{ display: "flex", alignItems: "center", gap: 3 }}>
                    <span style={{ fontFamily: FONT, fontSize: 9, letterSpacing: 1, color: "rgba(255,255,255,0.35)" }}>{f.label}</span>
                    <ParamInput group={group} field={f.key} aria={f.aria} />
                </label>
            ))}
        </div>
    );
}
