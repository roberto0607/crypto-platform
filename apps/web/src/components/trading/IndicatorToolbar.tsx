import { useState, useRef, useEffect } from "react";
import { useTradingStore } from "@/stores/tradingStore";

const OVERLAY_INDICATORS = [
  { key: "aiSignals", label: "AI Signals", color: "#10b981" },
  { key: "ema200", label: "EMA 200", color: "#a855f7" },
  { key: "ema50", label: "EMA 50", color: "#eab308" },
  { key: "vwap", label: "VWAP", color: "#06b6d4" },
  { key: "keyLevels", label: "Key Levels (PDH/PDL)", color: "#94a3b8" },
  { key: "swingPoints", label: "Swing Points", color: "#f97316" },
  { key: "orderFlow", label: "Order Flow", color: "#f59e0b" },
  { key: "derivatives", label: "Derivatives", color: "#ec4899" },
  { key: "forecastCone", label: "Forecast Cone", color: "#06b6d4" },
  { key: "regimeBands", label: "Regime Bands", color: "#8b5cf6" },
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
        className="px-2 py-1 text-xs rounded transition-colors text-gray-400 hover:text-gray-200 hover:bg-gray-800 flex items-center gap-1"
      >
        Indicators
        {activeCount > 0 && (
          <span className="bg-blue-600 text-white text-[10px] rounded-full px-1.5 leading-4">
            {activeCount}
          </span>
        )}
        <span className="text-[10px]">&#9662;</span>
      </button>

      {open && (
        <div className="absolute top-full left-0 mt-1 bg-gray-900 border border-gray-700 rounded shadow-lg z-50 min-w-[200px] py-1">
          <div className="px-3 py-1 text-[10px] text-gray-500 uppercase tracking-widest">
            On Chart
          </div>
          {OVERLAY_INDICATORS.map((ind) => (
            <button
              key={ind.key}
              onClick={() => toggle(ind.key)}
              className="flex items-center gap-2 px-3 py-1.5 hover:bg-gray-800 cursor-pointer w-full text-left"
            >
              <span
                className={`w-3.5 h-3.5 rounded border flex-shrink-0 flex items-center justify-center ${
                  config[ind.key]
                    ? "bg-blue-600 border-blue-600"
                    : "border-gray-600 bg-gray-800"
                }`}
              >
                {config[ind.key] && (
                  <svg className="w-2.5 h-2.5 text-white" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M2 6l3 3 5-5" />
                  </svg>
                )}
              </span>
              <span
                className="w-2 h-2 rounded-full flex-shrink-0"
                style={{ backgroundColor: ind.color }}
              />
              <span className="text-xs text-gray-300">{ind.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
