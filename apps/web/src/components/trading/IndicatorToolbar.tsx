import { useState, useRef, useEffect } from "react";
import { useTradingStore } from "@/stores/tradingStore";

const STANDARD_INDICATORS = [
  { key: "ema20", label: "EMA 20", color: "#3b82f6" },
  { key: "ema50", label: "EMA 50", color: "#f59e0b" },
  { key: "ema200", label: "EMA 200", color: "#ef4444" },
  { key: "vwap", label: "VWAP", color: "#a855f7" },
  { key: "bollingerBands", label: "Bollinger Bands", color: "#6366f1" },
  { key: "volume", label: "Volume", color: "#22c55e" },
  { key: "rsi", label: "RSI", color: "#f59e0b" },
  { key: "macd", label: "MACD", color: "#3b82f6" },
  { key: "atr", label: "ATR", color: "#a855f7" },
  { key: "delta", label: "Est. Delta", color: "#22c55e" },
] as const;

const ADVANCED_INDICATORS = [
  { key: "keyLevels", label: "Key Levels (PDH/PDL)", color: "#ff4d4d" },
  { key: "liquidityZones", label: "Liquidity Zones", color: "#f59e0b" },
  { key: "orderBlocks", label: "Order Blocks", color: "#00ff41" },
  { key: "cvd", label: "CVD", color: "#06b6d4" },
  { key: "marketIntelligence", label: "Market Intelligence", color: "rgba(147,51,234,1)" },
  { key: "fundingRate", label: "Funding Rate", color: "#06b6d4" },
  { key: "openInterest", label: "Open Interest", color: "#eab308" },
  { key: "vpvr", label: "VPVR", color: "#06b6d4" },
  { key: "orderbook", label: "Order Book Heatmap", color: "#7C3AED" },
] as const;

const ALL_INDICATORS = [...STANDARD_INDICATORS, ...ADVANCED_INDICATORS];

interface IndicatorToolbarProps {
  vpvrMode?: "visible" | "weekly" | "daily";
  onVpvrModeChange?: (mode: "visible" | "weekly" | "daily") => void;
}

export function IndicatorToolbar({ vpvrMode = "visible", onVpvrModeChange }: IndicatorToolbarProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const config = useTradingStore((s) => s.indicatorConfig);
  const toggle = useTradingStore((s) => s.toggleIndicator);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const activeCount = ALL_INDICATORS.filter((i) => config[i.key]).length;

  function renderRow(ind: { key: string; label: string; color: string }) {
    const active = config[ind.key as keyof typeof config];
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
        style={{
          padding: "4px 8px", fontSize: 12, borderRadius: 2,
          transition: "all 0.15s",
          color: "rgba(255,255,255,0.5)",
          background: "transparent",
          border: "1px solid rgba(0,255,65,0.16)",
          display: "flex", alignItems: "center", gap: 4,
          fontFamily: "'Space Mono', monospace",
          letterSpacing: 1,
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(0,255,65,0.1)"; e.currentTarget.style.color = "#fff"; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "rgba(255,255,255,0.5)"; }}
      >
        Indicators
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
          position: "absolute", top: "100%", left: 0, marginTop: 4,
          background: "#080808",
          border: "1px solid rgba(0,255,65,0.16)",
          borderRadius: 2,
          boxShadow: "0 4px 20px rgba(0,0,0,0.6)",
          zIndex: 50, minWidth: 220, padding: "4px 0",
          maxHeight: 400, overflowY: "auto",
        }}>
          <div style={{ padding: "4px 12px", fontSize: 9, color: "rgba(255,255,255,0.25)", letterSpacing: 3 }}>
            STANDARD
          </div>
          {STANDARD_INDICATORS.map(renderRow)}

          <div style={{ height: 1, background: "rgba(255,255,255,0.06)", margin: "4px 0" }} />

          <div style={{ padding: "4px 12px", fontSize: 9, color: "rgba(255,255,255,0.25)", letterSpacing: 3 }}>
            ADVANCED
          </div>
          {ADVANCED_INDICATORS.map((ind) => (
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
        </div>
      )}
    </div>
  );
}
