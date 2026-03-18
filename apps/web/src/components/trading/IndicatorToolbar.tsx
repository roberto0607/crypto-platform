import { useState, useRef, useEffect } from "react";
import { useTradingStore } from "@/stores/tradingStore";

const OVERLAY_INDICATORS = [
  { key: "keyLevels", label: "Key Levels (PDH/PDL)", color: "#ff4d4d" },
  { key: "liquidityZones", label: "Liquidity Zones", color: "#f59e0b" },
  { key: "orderBlocks", label: "Order Blocks", color: "#00ff41" },
  { key: "cvd", label: "CVD", color: "#06b6d4" },
  { key: "marketIntelligence", label: "Market Intelligence", color: "rgba(147,51,234,1)" },
] as const;

export function IndicatorToolbar() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const config = useTradingStore((s) => s.indicatorConfig);
  const toggle = useTradingStore((s) => s.toggleIndicator);

  // Close dropdown on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const activeCount = OVERLAY_INDICATORS.filter((i) => config[i.key]).length;

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
          zIndex: 50, minWidth: 200, padding: "4px 0",
        }}>
          <div style={{
            padding: "4px 12px", fontSize: 10,
            color: "rgba(255,255,255,0.25)", letterSpacing: 3,
            textTransform: "uppercase",
          }}>
            On Chart
          </div>
          {OVERLAY_INDICATORS.map((ind) => (
            <button
              key={ind.key}
              onClick={() => toggle(ind.key)}
              style={{
                display: "flex", alignItems: "center", gap: 8,
                padding: "6px 12px", cursor: "pointer",
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
                background: config[ind.key] ? "#00ff41" : "rgba(255,255,255,0.04)",
                border: config[ind.key] ? "1px solid #00ff41" : "1px solid rgba(255,255,255,0.15)",
              }}>
                {config[ind.key] && (
                  <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="#000" strokeWidth="2">
                    <path d="M2 6l3 3 5-5" />
                  </svg>
                )}
              </span>
              <span
                style={{
                  width: 8, height: 8, borderRadius: "50%", flexShrink: 0,
                  backgroundColor: ind.color,
                }}
              />
              <span style={{ fontSize: 12, color: "rgba(255,255,255,0.7)", fontFamily: "'Space Mono', monospace" }}>{ind.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
