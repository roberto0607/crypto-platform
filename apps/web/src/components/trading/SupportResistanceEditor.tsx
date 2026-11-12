import { CHART_LAYOUT_CATALOG, type SupportResistanceOptions } from "@/lib/chartLayouts/catalog";
import { srConfirmText } from "@/lib/srDisplay";
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

function Switch({ name, aria, on, onChange }: { name: string; aria: string; on: boolean; onChange: (on: boolean) => void }) {
    return (
        <label style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
            <input type="checkbox" aria-label={aria} checked={on} onChange={(e) => onChange(e.target.checked)} style={{ margin: 0 }} />
            <span style={LABEL}>{name}</span>
        </label>
    );
}

/**
 * Support/resistance settings under its menu row: pivot lengths and the
 * × ATR distances, how many levels are drawn in full, HTF levels, broken
 * history, the volume filter and max age (their numbers only while on), and
 * how late a level is confirmed on the current timeframe.
 */
export function SupportResistanceEditor() {
    const timeframe = useChartLayoutStore((s) => s.timeframe);
    const params = useIndicatorSettingsStore((s) => s.supportResistance);
    const opts = useIndicatorSettingsStore((s) => s.supportResistanceOptions);
    const setOpts = useIndicatorSettingsStore((s) => s.setSupportResistanceOptions);
    const onOff = (on: boolean): "on" | "off" => (on ? "on" : "off");

    return (
        <div
            data-testid="sr-settings"
            style={{ display: "flex", flexDirection: "column", gap: 6, padding: "2px 12px 6px 34px" }}
            onClick={(e) => e.stopPropagation()}
        >
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
                <Field k="left" />
                <Field k="right" />
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
                {srConfirmText(params, opts, timeframe).map((t) => (
                    <span key={t} style={{ ...LABEL, letterSpacing: 0.5, color: "rgba(255,255,255,0.5)" }}>{t}</span>
                ))}
            </div>
        </div>
    );
}
