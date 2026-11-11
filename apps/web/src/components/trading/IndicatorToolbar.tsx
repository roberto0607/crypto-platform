import { useState, useRef, useEffect } from "react";
import { useTradingStore } from "@/stores/tradingStore";
import { useIndicatorSettingsStore } from "@/stores/indicatorSettingsStore";
import { MovingAveragesEditor } from "./MovingAveragesEditor";
import { IndicatorParamsEditor } from "./IndicatorParamsEditor";

/** Not a toggle: a list of lines (indicatorSettingsStore), edited inline. */
const MOVING_AVERAGES_KEY = "movingAverages";

interface MenuItem {
  key: string;
  label: string;
  color: string;
  /** Extra search terms (the label always matches too). */
  aliases?: readonly string[];
}

const STANDARD_INDICATORS: readonly MenuItem[] = [
  {
    key: MOVING_AVERAGES_KEY, label: "Moving Averages", color: "#3b82f6",
    aliases: ["moving average", "ma", "sma", "ema", "simple moving average", "exponential moving average", "golden cross", "death cross"],
  },
  { key: "vwap", label: "VWAP", color: "#a855f7" },
  { key: "bollingerBands", label: "Bollinger Bands", color: "#6366f1" },
  { key: "volume", label: "Volume", color: "#22c55e" },
  { key: "rsi", label: "RSI", color: "#f59e0b" },
  { key: "macd", label: "MACD", color: "#3b82f6" },
  { key: "atr", label: "ATR", color: "#a855f7" },
  { key: "delta", label: "Est. Delta", color: "#22c55e" },
  {
    key: "adx", label: "ADX / DMI", color: "#e5e7eb",
    aliases: ["adx", "dmi", "trend strength", "average directional index", "directional movement", "di+", "di-"],
  },
];

const ADVANCED_INDICATORS: readonly MenuItem[] = [
  {
    key: "keyLevels", label: "Key Levels (PDH/PDL/PWH/PWL)", color: "#ff4d4d",
    aliases: ["key levels", "pdh", "pdl", "pwh", "pwl", "previous day", "previous week", "daily high", "daily low", "weekly high", "weekly low"],
  },
  {
    key: "utBot", label: "UT Bot", color: "#22c55e",
    aliases: ["ut bot", "ut bot alerts", "trailing stop", "atr trailing stop", "buy sell signals"],
  },
  {
    key: "swings", label: "Swing Highs/Lows", color: "#e5e7eb",
    aliases: ["swing", "swing high", "swing low", "pivot", "pivots", "fractal"],
  },
  { key: "liquidityZones", label: "Liquidity Zones", color: "#f59e0b" },
  { key: "orderBlocks", label: "Order Blocks", color: "#00ff41" },
  { key: "cvd", label: "CVD", color: "#06b6d4" },
  { key: "fundingRate", label: "Funding Rate", color: "#06b6d4" },
  { key: "openInterest", label: "Open Interest", color: "#eab308" },
  { key: "vpvr", label: "VPVR", color: "#06b6d4" },
  { key: "orderbook", label: "Order Book Heatmap", color: "#7C3AED" },
  { key: "footprint", label: "Footprint", color: "#F59E0B" },
  { key: "liquidationLevels", label: "Liquidation Levels (EST.)", color: "#ff3232" },
  { key: "cotReport", label: "COT Report (CFTC)", color: "#22c55e" },
];

const ALL_INDICATORS = [...STANDARD_INDICATORS, ...ADVANCED_INDICATORS];

interface IndicatorToolbarProps {
  vpvrMode?: "visible" | "weekly" | "daily";
  onVpvrModeChange?: (mode: "visible" | "weekly" | "daily") => void;
}

export function IndicatorToolbar({ vpvrMode = "visible", onVpvrModeChange }: IndicatorToolbarProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [queryFocused, setQueryFocused] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const config = useTradingStore((s) => s.indicatorConfig);
  const toggle = useTradingStore((s) => s.toggleIndicator);
  const maCount = useIndicatorSettingsStore((s) => s.movingAverages.length);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Reset the filter whenever the panel closes so re-opening it always
  // starts from the full list rather than a stale search.
  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  // Each moving-average line counts as one indicator.
  const activeCount = ALL_INDICATORS.filter((i) => (config as Record<string, boolean>)[i.key]).length + maCount;

  const trimmedQuery = query.trim().toLowerCase();
  const matches = (i: MenuItem) => [i.label, ...(i.aliases ?? [])].some((t) => t.toLowerCase().startsWith(trimmedQuery));
  const filteredStandard = trimmedQuery ? STANDARD_INDICATORS.filter(matches) : [];
  const filteredAdvanced = trimmedQuery ? ADVANCED_INDICATORS.filter(matches) : [];
  const noMatches = trimmedQuery.length > 0 && filteredStandard.length === 0 && filteredAdvanced.length === 0;

  function renderMovingAverages(ind: MenuItem) {
    return (
      <div key={ind.key}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 12px" }}>
          <span style={{ width: 14, flexShrink: 0 }} />
          <span style={{ width: 8, height: 8, borderRadius: "50%", flexShrink: 0, backgroundColor: ind.color }} />
          <span style={{ fontSize: 12, color: "rgba(255,255,255,0.7)", fontFamily: "'Space Mono', monospace" }}>{ind.label}</span>
          {maCount > 0 && <span style={{ fontSize: 10, color: "rgba(255,255,255,0.35)", fontFamily: "'Space Mono', monospace" }}>({maCount})</span>}
        </div>
        <MovingAveragesEditor />
      </div>
    );
  }

  function renderRow(ind: MenuItem) {
    if (ind.key === MOVING_AVERAGES_KEY) return renderMovingAverages(ind);
    const active = config[ind.key as keyof typeof config];
    const settings = ind.key === "adx" || ind.key === "utBot" ? ind.key : null;
    if (settings) {
      return (
        <div key={ind.key}>
          {renderToggle(ind, active)}
          {active && <IndicatorParamsEditor group={settings} />}
        </div>
      );
    }
    return renderToggle(ind, active);
  }

  function renderToggle(ind: MenuItem, active: boolean) {
    return (
      <button
        key={ind.key}
        onClick={() => toggle(ind.key as keyof typeof config)}
        style={{
          display: "flex", alignItems: "center", gap: 8,
          padding: "5px 12px", cursor: "pointer",
          width: "100%", textAlign: "left",
          background: "transparent", border: "none",
          transition: "background 0.15s",
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(0,255,65,0.1)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
      >
        <span style={{
          width: 14, height: 14, borderRadius: 2, flexShrink: 0,
          display: "flex", alignItems: "center", justifyContent: "center",
          background: active ? "#00ff41" : "rgba(255,255,255,0.04)",
          border: active ? "1px solid #00ff41" : "1px solid rgba(255,255,255,0.15)",
        }}>
          {active && (
            <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="#000" strokeWidth="2">
              <path d="M2 6l3 3 5-5" />
            </svg>
          )}
        </span>
        <span style={{ width: 8, height: 8, borderRadius: "50%", flexShrink: 0, backgroundColor: ind.color }} />
        <span style={{ fontSize: 12, color: "rgba(255,255,255,0.7)", fontFamily: "'Space Mono', monospace" }}>{ind.label}</span>
      </button>
    );
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        title="Indicators"
        aria-label="Indicators"
        style={{
          padding: "5px 9px", fontSize: 12, borderRadius: 2,
          transition: "all 0.15s",
          color: "rgba(255,255,255,0.92)",
          fontWeight: 700,
          background: "transparent",
          border: "1px solid rgba(0,255,65,0.2)",
          display: "flex", alignItems: "center", gap: 4,
          fontFamily: "'Space Mono', monospace",
          letterSpacing: 1,
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(0,255,65,0.1)"; e.currentTarget.style.color = "#fff"; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "rgba(255,255,255,0.92)"; }}
      >
        {/* Waveform/bar-chart glyph — hand-drawn inline SVG, same convention as
            NavIcon.tsx (dependency-free icon set). Replaces the old gear glyph
            now that this trigger is one of the 5 bold toolbar elements; the
            "Indicators" label lives in title/aria-label to save toolbar width,
            the active-count badge below still shows. */}
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <line x1="3" y1="13" x2="3" y2="7" />
          <line x1="8" y1="13" x2="8" y2="3" />
          <line x1="13" y1="13" x2="13" y2="9" />
        </svg>
        {activeCount > 0 && (
          <span style={{
            background: "#00ff41", color: "#000",
            fontSize: 10, borderRadius: 9, padding: "0 6px",
            lineHeight: "16px", fontWeight: 700,
          }}>
            {activeCount}
          </span>
        )}
        <span style={{ fontSize: 10 }}>&#9662;</span>
      </button>

      {open && (
        <div style={{
          // Anchor to the trigger's RIGHT edge so the menu opens leftward and
          // stays within the chart area. The trigger sits at the right edge of
          // the toolbar, so a left:0 (rightward) menu spills under the order
          // panel and gets clipped — pre-existing, and worse now the gear
          // trigger is narrower (anchor sits further right).
          position: "absolute", top: "100%", right: 0, marginTop: 4,
          background: "#080808",
          border: "1px solid rgba(0,255,65,0.16)",
          borderRadius: 2,
          boxShadow: "0 4px 20px rgba(0,0,0,0.6)",
          zIndex: 50, minWidth: 220, padding: "4px 0",
          maxHeight: 400, overflowY: "auto",
        }}>
          <div style={{ padding: "6px 8px 4px" }}>
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onFocus={() => setQueryFocused(true)}
              onBlur={() => setQueryFocused(false)}
              placeholder="Search indicators..."
              autoFocus
              style={{
                width: "100%", height: 28, boxSizing: "border-box",
                background: "rgba(255,255,255,0.04)",
                border: queryFocused ? "1px solid rgba(0,255,65,0.25)" : "1px solid rgba(255,255,255,0.1)",
                borderRadius: 2, padding: "0 8px",
                fontFamily: "'Space Mono', monospace", fontSize: 11, letterSpacing: 1,
                color: "rgba(255,255,255,0.88)", outline: "none",
              }}
            />
          </div>

          {trimmedQuery.length === 0 ? null : noMatches ? (
            <div style={{
              padding: "10px 12px", fontSize: 9, letterSpacing: 2,
              color: "rgba(255,255,255,0.3)", textTransform: "uppercase", textAlign: "center",
            }}>
              No indicators found
            </div>
          ) : (
            <>
              {filteredStandard.length > 0 && (
                <>
                  <div style={{ padding: "4px 12px", fontSize: 9, color: "rgba(255,255,255,0.25)", letterSpacing: 3 }}>
                    STANDARD
                  </div>
                  {filteredStandard.map(renderRow)}
                </>
              )}

              {filteredStandard.length > 0 && filteredAdvanced.length > 0 && (
                <div style={{ height: 1, background: "rgba(255,255,255,0.06)", margin: "4px 0" }} />
              )}

              {filteredAdvanced.length > 0 && (
                <>
                  <div style={{ padding: "4px 12px", fontSize: 9, color: "rgba(255,255,255,0.25)", letterSpacing: 3 }}>
                    ADVANCED
                  </div>
                  {filteredAdvanced.map((ind) => (
                    <div key={ind.key}>
                      {renderRow(ind)}
                      {ind.key === "vpvr" && config.vpvr && onVpvrModeChange && (
                        <div style={{ display: "flex", gap: 2, padding: "2px 12px 4px 34px" }}>
                          {(["visible", "daily", "weekly"] as const).map((m) => (
                            <button
                              key={m}
                              onClick={(e) => { e.stopPropagation(); onVpvrModeChange(m); }}
                              style={{
                                padding: "2px 8px", fontSize: 9, letterSpacing: 1,
                                border: "none", cursor: "pointer",
                                background: vpvrMode === m ? "rgba(255,107,0,0.25)" : "transparent",
                                color: vpvrMode === m ? "#FF6B00" : "rgba(255,255,255,0.25)",
                                fontFamily: "'Space Mono', monospace",
                                transition: "all 0.1s",
                              }}
                            >
                              {m === "visible" ? "VISIBLE" : m === "daily" ? "DAILY" : "WEEKLY"}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
