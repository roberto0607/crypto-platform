import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTradingStore } from "@/stores/tradingStore";
import { useChartLayoutStore, layoutConfigById } from "@/stores/chartLayoutStore";
import { useIndicatorSettingsStore } from "@/stores/indicatorSettingsStore";
import { PRESETS, isModified, isPresetId, type IndicatorToggles } from "@/lib/chartLayouts/layoutConfig";
import { CHART_LAYOUT_CATALOG } from "@/lib/chartLayouts/catalog";

/**
 * "Layouts" dropdown in the chart toolbar: read-only presets, the user's
 * saved layouts (server-side, /v1/chart-layouts), and Save as / Update /
 * Rename / Delete / Set as default. Applying a layout is instant (store
 * updates, no reload). A dot next to the name means the chart no longer
 * matches the active layout.
 */

type Mode = "menu" | "save" | "rename" | "delete";

const MONO = "'Space Mono', monospace";
const sectionLabel: React.CSSProperties = { padding: "6px 12px 4px", fontSize: 9, color: "rgba(255,255,255,0.3)", letterSpacing: 3 };
const rowBase: React.CSSProperties = {
    display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left",
    padding: "6px 12px", background: "transparent", border: "none", cursor: "pointer",
    fontFamily: MONO, fontSize: 12, color: "rgba(255,255,255,0.8)",
};
const actionBtn: React.CSSProperties = {
    ...rowBase, fontSize: 10, letterSpacing: 1.5, textTransform: "uppercase", padding: "6px 12px",
};
const inputStyle: React.CSSProperties = {
    width: "100%", height: 28, boxSizing: "border-box", background: "rgba(255,255,255,0.04)",
    border: "1px solid rgba(0,255,65,0.25)", borderRadius: 2, padding: "0 8px",
    fontFamily: MONO, fontSize: 12, color: "rgba(255,255,255,0.9)", outline: "none",
};
const smallBtn = (primary: boolean): React.CSSProperties => ({
    flex: 1, padding: "5px 8px", fontFamily: MONO, fontSize: 10, letterSpacing: 1.5, fontWeight: 700,
    cursor: "pointer", borderRadius: 2, textTransform: "uppercase",
    border: primary ? "1px solid #00ff41" : "1px solid rgba(255,255,255,0.15)",
    background: primary ? "#00ff41" : "transparent", color: primary ? "#000" : "rgba(255,255,255,0.8)",
});

function hover(e: React.MouseEvent<HTMLElement>, on: boolean) {
    if ((e.currentTarget as HTMLButtonElement).disabled) return;
    e.currentTarget.style.background = on ? "rgba(0,255,65,0.1)" : "transparent";
}

export function LayoutsMenu() {
    const [open, setOpen] = useState(false);
    const [mode, setMode] = useState<Mode>("menu");
    const [name, setName] = useState("");
    const [makeDefault, setMakeDefault] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [anchorLeft, setAnchorLeft] = useState(false);
    const ref = useRef<HTMLDivElement>(null);

    const layouts = useChartLayoutStore((s) => s.layouts);
    const activeId = useChartLayoutStore((s) => s.activeLayoutId);
    const loadLayouts = useChartLayoutStore((s) => s.loadLayouts);
    const applyLayout = useChartLayoutStore((s) => s.applyLayout);

    // Everything the modified dot compares.
    const indicators = useTradingStore((s) => s.indicatorConfig);
    const movingAverages = useIndicatorSettingsStore((s) => s.movingAverages);
    const maCross = useIndicatorSettingsStore((s) => s.maCross);
    const vpvrMode = useChartLayoutStore((s) => s.vpvrMode);
    const paneOrder = useChartLayoutStore((s) => s.paneOrder);
    const paneCollapsed = useChartLayoutStore((s) => s.paneCollapsed);
    const paneHeights = useChartLayoutStore((s) => s.paneHeights);
    const timeframe = useChartLayoutStore((s) => s.timeframe);

    useEffect(() => { void loadLayouts(); }, [loadLayouts]);

    useEffect(() => {
        if (!open) return;
        const handler = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
        };
        document.addEventListener("mousedown", handler);
        return () => document.removeEventListener("mousedown", handler);
    }, [open]);

    useEffect(() => {
        if (!open) { setMode("menu"); setError(null); }
    }, [open]);

    // Open toward whichever side has room (the toolbar wraps at phone width,
    // so the trigger can end up near either edge).
    useLayoutEffect(() => {
        if (!open || !ref.current) return;
        const r = ref.current.getBoundingClientRect();
        setAnchorLeft(r.right < Math.min(280, window.innerWidth - 10));
    }, [open]);

    const activeConfig = layoutConfigById(activeId);
    const activeName = isPresetId(activeId)
        ? PRESETS.find((p) => p.id === activeId)?.name
        : layouts.find((l) => l.id === activeId)?.name;
    const modified = activeConfig !== null && isModified(activeConfig, {
        indicators: indicators as IndicatorToggles, settings: { movingAverages, maCross }, vpvrMode, paneOrder, paneCollapsed, paneHeights, timeframe,
    });
    const activeSaved = activeId && !isPresetId(activeId) ? layouts.find((l) => l.id === activeId) ?? null : null;
    const atCap = layouts.length >= CHART_LAYOUT_CATALOG.maxLayoutsPerUser;

    async function run(fn: () => Promise<unknown>, after: Mode | "close" = "menu") {
        setBusy(true);
        setError(null);
        try {
            await fn();
            if (after === "close") setOpen(false);
            else setMode(after);
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setBusy(false);
        }
    }

    function pick(id: string) {
        applyLayout(id);
        setOpen(false);
    }

    function renderLayoutRow(id: string, label: string, isDefault: boolean) {
        const active = id === activeId;
        return (
            <button
                key={id}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                onClick={() => pick(id)}
                style={{ ...rowBase, color: active ? "#00ff41" : rowBase.color }}
                onMouseEnter={(e) => hover(e, true)}
                onMouseLeave={(e) => hover(e, false)}
            >
                <span style={{ width: 10, flexShrink: 0, fontSize: 10 }}>{active ? "✓" : ""}</span>
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
                {isDefault && <span title="Default layout" style={{ fontSize: 9, letterSpacing: 1, color: "rgba(255,255,255,0.45)" }}>DEFAULT</span>}
            </button>
        );
    }

    const nameForm = (submitLabel: string, onSubmit: () => void, withDefault: boolean) => (
        <form
            onSubmit={(e) => { e.preventDefault(); if (!busy && name.trim()) onSubmit(); }}
            style={{ padding: "8px 12px", display: "flex", flexDirection: "column", gap: 8 }}
        >
            <input
                aria-label="Layout name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={CHART_LAYOUT_CATALOG.nameMaxLength}
                placeholder="Layout name"
                autoFocus
                style={inputStyle}
            />
            {withDefault && (
                <label style={{ display: "flex", alignItems: "center", gap: 6, fontFamily: MONO, fontSize: 10, color: "rgba(255,255,255,0.7)", cursor: "pointer" }}>
                    <input type="checkbox" checked={makeDefault} onChange={(e) => setMakeDefault(e.target.checked)} />
                    Set as default
                </label>
            )}
            {error && <div role="alert" style={{ fontFamily: MONO, fontSize: 10, color: "#ff6b6b" }}>{error}</div>}
            <div style={{ display: "flex", gap: 6 }}>
                <button type="button" style={smallBtn(false)} onClick={() => { setMode("menu"); setError(null); }}>Cancel</button>
                <button type="submit" style={smallBtn(true)} disabled={busy || !name.trim()}>{submitLabel}</button>
            </div>
        </form>
    );

    return (
        <div ref={ref} style={{ position: "relative", flexShrink: 0 }}>
            <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                title="Chart layouts"
                aria-label="Chart layouts"
                aria-haspopup="menu"
                aria-expanded={open}
                style={{
                    padding: "5px 9px", fontSize: 11, borderRadius: 2, fontWeight: 700, letterSpacing: 1,
                    color: "rgba(255,255,255,0.92)", background: "transparent", border: "1px solid rgba(0,255,65,0.2)",
                    display: "flex", alignItems: "center", gap: 5, fontFamily: MONO, cursor: "pointer", maxWidth: 170,
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(0,255,65,0.1)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
            >
                <span data-testid="layout-trigger-name" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
                    {activeName ?? "LAYOUT"}
                </span>
                {modified && (
                    <span
                        data-testid="layout-modified-dot"
                        title="Modified — differs from the saved layout"
                        aria-label="modified"
                        style={{ width: 6, height: 6, borderRadius: "50%", background: "#FF6B00", flexShrink: 0 }}
                    />
                )}
                <span style={{ fontSize: 10 }}>&#9662;</span>
            </button>

            {open && (
                <div
                    role="menu"
                    style={{
                        position: "absolute", top: "100%", marginTop: 4,
                        ...(anchorLeft ? { left: 0 } : { right: 0 }),
                        width: 240, maxWidth: "calc(100vw - 20px)", boxSizing: "border-box",
                        background: "#080808", border: "1px solid rgba(0,255,65,0.16)", borderRadius: 2,
                        boxShadow: "0 4px 20px rgba(0,0,0,0.6)", zIndex: 50, padding: "4px 0",
                        maxHeight: "min(460px, 70vh)", overflowY: "auto",
                    }}
                >
                    {mode === "save" && nameForm("Save", () =>
                        run(() => useChartLayoutStore.getState().saveAs(name.trim(), { isDefault: makeDefault }), "close"), true)}

                    {mode === "rename" && activeSaved && nameForm("Rename", () =>
                        run(() => useChartLayoutStore.getState().renameLayout(activeSaved.id, name.trim())), false)}

                    {mode === "delete" && activeSaved && (
                        <div style={{ padding: "8px 12px", display: "flex", flexDirection: "column", gap: 8 }}>
                            <div style={{ fontFamily: MONO, fontSize: 11, color: "rgba(255,255,255,0.8)", wordBreak: "break-word" }}>
                                Delete “{activeSaved.name}”?
                            </div>
                            {error && <div role="alert" style={{ fontFamily: MONO, fontSize: 10, color: "#ff6b6b" }}>{error}</div>}
                            <div style={{ display: "flex", gap: 6 }}>
                                <button type="button" style={smallBtn(false)} onClick={() => setMode("menu")}>Cancel</button>
                                <button
                                    type="button"
                                    style={{ ...smallBtn(true), background: "#ff3b3b", borderColor: "#ff3b3b" }}
                                    disabled={busy}
                                    onClick={() => run(() => useChartLayoutStore.getState().deleteLayout(activeSaved.id))}
                                >
                                    Delete
                                </button>
                            </div>
                        </div>
                    )}

                    {mode === "menu" && (
                        <>
                            <div style={sectionLabel}>PRESETS</div>
                            {PRESETS.map((p) => renderLayoutRow(p.id, p.name, false))}

                            <div style={{ height: 1, background: "rgba(255,255,255,0.06)", margin: "4px 0" }} />
                            <div style={sectionLabel}>MY LAYOUTS</div>
                            {layouts.length === 0 ? (
                                <div style={{ padding: "4px 12px 6px", fontFamily: MONO, fontSize: 10, color: "rgba(255,255,255,0.35)" }}>
                                    No saved layouts yet
                                </div>
                            ) : (
                                layouts.map((l) => renderLayoutRow(l.id, l.name, l.is_default))
                            )}

                            <div style={{ height: 1, background: "rgba(255,255,255,0.06)", margin: "4px 0" }} />
                            {error && <div role="alert" style={{ padding: "4px 12px", fontFamily: MONO, fontSize: 10, color: "#ff6b6b" }}>{error}</div>}
                            <button
                                type="button"
                                style={{ ...actionBtn, opacity: atCap ? 0.4 : 1 }}
                                disabled={atCap}
                                title={atCap ? `Max ${CHART_LAYOUT_CATALOG.maxLayoutsPerUser} layouts` : undefined}
                                onClick={() => { setName(""); setMakeDefault(false); setError(null); setMode("save"); }}
                                onMouseEnter={(e) => hover(e, true)}
                                onMouseLeave={(e) => hover(e, false)}
                            >
                                Save current as…
                            </button>
                            {activeSaved && (
                                <>
                                    <button
                                        type="button"
                                        style={{ ...actionBtn, opacity: modified ? 1 : 0.4 }}
                                        disabled={busy || !modified}
                                        onClick={() => run(() => useChartLayoutStore.getState().updateActive())}
                                        onMouseEnter={(e) => hover(e, true)}
                                        onMouseLeave={(e) => hover(e, false)}
                                    >
                                        Update “{activeSaved.name}”
                                    </button>
                                    <button
                                        type="button"
                                        style={actionBtn}
                                        onClick={() => { setName(activeSaved.name); setError(null); setMode("rename"); }}
                                        onMouseEnter={(e) => hover(e, true)}
                                        onMouseLeave={(e) => hover(e, false)}
                                    >
                                        Rename
                                    </button>
                                    <button
                                        type="button"
                                        style={actionBtn}
                                        disabled={busy}
                                        onClick={() => run(() => useChartLayoutStore.getState().setDefault(activeSaved.id, !activeSaved.is_default))}
                                        onMouseEnter={(e) => hover(e, true)}
                                        onMouseLeave={(e) => hover(e, false)}
                                    >
                                        {activeSaved.is_default ? "Unset default" : "Set as default"}
                                    </button>
                                    <button
                                        type="button"
                                        style={{ ...actionBtn, color: "#ff6b6b" }}
                                        onClick={() => { setError(null); setMode("delete"); }}
                                        onMouseEnter={(e) => hover(e, true)}
                                        onMouseLeave={(e) => hover(e, false)}
                                    >
                                        Delete
                                    </button>
                                </>
                            )}
                        </>
                    )}
                </div>
            )}
        </div>
    );
}
