import { useEffect, useState } from "react";
import { CHART_LAYOUT_CATALOG, type ChartTimeframe, type SupportResistanceOptions } from "@/lib/chartLayouts/catalog";
import { clampParam, srPivotFor } from "@/lib/chartLayouts/layoutConfig";
import { srConfirmText, srParamsForTimeframe } from "@/lib/srDisplay";
import { useChartLayoutStore } from "@/stores/chartLayoutStore";
import { useIndicatorSettingsStore } from "@/stores/indicatorSettingsStore";
import { ParamInput, SR_FIELDS } from "./IndicatorParamsEditor";

const FONT = "'Space Mono', monospace";
const LABEL = { fontFamily: FONT, fontSize: 9, letterSpacing: 1, color: "rgba(255,255,255,0.35)" } as const;
const HTF_LABELS: Record<SupportResistanceOptions["htf"], string> = { off: "Off", "1d": "1D", "1w": "1W", "1d+1w": "1D + 1W" };

type Key = (typeof SR_FIELDS)[number]["key"];

function Field({ k }: { k: Key }) {
    const f = SR_FIELDS.find((x) => x.key === k)!;
    return (
        <label style={{ display: "flex", alignItems: "center", gap: 3 }}>
            <span style={LABEL}>{f.label}</span>
            <ParamInput group="supportResistance" field={f.key} aria={f.aria} />
        </label>
    );
}

const PIVOT_RANGE = CHART_LAYOUT_CATALOG.numericParams.supportResistance.left;

/** LEFT/RIGHT of the hand-set pivot on one timeframe (same typed-number behavior as ParamInput). */
function PivotInput({ tf, side }: { tf: ChartTimeframe; side: "left" | "right" }) {
    const pivots = useIndicatorSettingsStore((s) => s.supportResistancePivots);
    const pivot = srPivotFor({ supportResistancePivots: pivots }, tf);
    const setPivot = useIndicatorSettingsStore((s) => s.setSupportResistancePivot);
    const value = pivot[side];
    const [draft, setDraft] = useState(String(value));
    useEffect(() => setDraft(String(value)), [value]);

    function commit(text: string) {
        setDraft(text);
        const n = Number(text);
        if (text.trim() === "" || !Number.isFinite(n) || n < PIVOT_RANGE.min) return;
        setPivot(tf, { left: pivot.left, right: pivot.right, [side]: clampParam(PIVOT_RANGE, n) });
    }

    return (
        <label style={{ display: "flex", alignItems: "center", gap: 3 }}>
            <span style={LABEL}>{side.toUpperCase()}</span>
            <input
                aria-label={`S/R pivot bars ${side}`}
                type="number"
                inputMode="numeric"
                min={PIVOT_RANGE.min}
                max={PIVOT_RANGE.max}
                step={PIVOT_RANGE.step}
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
        </label>
    );
}

/**
 * Pivot length on the chart's current timeframe: AUTO (the catalog's length
 * for it) or set by hand there — each timeframe keeps its own.
 */
function PivotControl({ tf }: { tf: ChartTimeframe }) {
    const pivots = useIndicatorSettingsStore((s) => s.supportResistancePivots);
    const pivot = srPivotFor({ supportResistancePivots: pivots }, tf);
    const setPivot = useIndicatorSettingsStore((s) => s.setSupportResistancePivot);
    return (
        <>
            <Switch
                name="AUTO"
                aria="S/R pivot length auto"
                on={pivot.auto}
                onChange={(on) => setPivot(tf, on ? null : { left: pivot.left, right: pivot.right })}
            />
            {pivot.auto ? (
                <span style={{ ...LABEL, color: "rgba(255,255,255,0.6)" }}>
                    PIVOT <span data-testid="sr-pivot-auto">{pivot.left} / {pivot.right}</span>
                </span>
            ) : (
                <><PivotInput tf={tf} side="left" /><PivotInput tf={tf} side="right" /></>
            )}
        </>
    );
}

function Switch({ name, aria, on, onChange }: { name: string; aria: string; on: boolean; onChange: (on: boolean) => void }) {
    return (
        <label style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
            <input type="checkbox" aria-label={aria} checked={on} onChange={(e) => onChange(e.target.checked)} style={{ margin: 0 }} />
            <span style={LABEL}>{name}</span>
        </label>
    );
}

/**
 * Support/resistance settings under its menu row: the pivot length on this
 * timeframe (Auto or by hand), the
 * × ATR distances, how many levels are drawn in full, HTF levels, broken
 * history, the volume filter and max age (their numbers only while on), and
 * how late a level is confirmed on the current timeframe.
 */
export function SupportResistanceEditor() {
    const timeframe = useChartLayoutStore((s) => s.timeframe);
    const params = useIndicatorSettingsStore((s) => s.supportResistance);
    const opts = useIndicatorSettingsStore((s) => s.supportResistanceOptions);
    const pivots = useIndicatorSettingsStore((s) => s.supportResistancePivots);
    const setOpts = useIndicatorSettingsStore((s) => s.setSupportResistanceOptions);
    const onOff = (on: boolean): "on" | "off" => (on ? "on" : "off");

    return (
        <div
            data-testid="sr-settings"
            style={{ display: "flex", flexDirection: "column", gap: 6, padding: "2px 12px 6px 34px" }}
            onClick={(e) => e.stopPropagation()}
        >
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
                <PivotControl tf={timeframe as ChartTimeframe} />
                <Field k="nearest" />
                <Field k="mergeAtr" />
                <Field k="breakAtr" />
                <Field k="maxZoneAtr" />
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
                <label style={{ display: "flex", alignItems: "center", gap: 3 }}>
                    <span style={LABEL}>HTF</span>
                    <select
                        aria-label="S/R higher-timeframe levels"
                        value={opts.htf}
                        onChange={(e) => setOpts({ htf: e.target.value as SupportResistanceOptions["htf"] })}
                        style={{
                            height: 22, fontFamily: FONT, fontSize: 10, background: "rgba(255,255,255,0.04)",
                            color: "rgba(255,255,255,0.85)", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 2,
                        }}
                    >
                        {CHART_LAYOUT_CATALOG.params.supportResistanceOptions.htf.map((v) => (
                            <option key={v} value={v}>{HTF_LABELS[v]}</option>
                        ))}
                    </select>
                </label>
                {opts.htf !== "off" && <><Field k="htfLeft" /><Field k="htfRight" /></>}
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
                <Switch name="BROKEN" aria="S/R show broken levels" on={opts.showBroken === "on"} onChange={(on) => setOpts({ showBroken: onOff(on) })} />
                <Switch name="VOL FILTER" aria="S/R volume filter" on={opts.volumeFilter === "on"} onChange={(on) => setOpts({ volumeFilter: onOff(on) })} />
                {opts.volumeFilter === "on" && <Field k="volumeMult" />}
                <Switch name="MAX AGE" aria="S/R max age" on={opts.maxAge === "on"} onChange={(on) => setOpts({ maxAge: onOff(on) })} />
                {opts.maxAge === "on" && <Field k="maxAgeBars" />}
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
                {srConfirmText(srParamsForTimeframe(params, pivots, timeframe), opts, timeframe).map((t) => (
                    <span key={t} style={{ ...LABEL, letterSpacing: 0.5, color: "rgba(255,255,255,0.5)" }}>{t}</span>
                ))}
            </div>
        </div>
    );
}
