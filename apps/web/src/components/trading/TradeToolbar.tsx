import { useState, useRef, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuthStore } from "@/stores/authStore";
import { useTradingStore } from "@/stores/tradingStore";
import { useAppStore } from "@/stores/appStore";
import { searchPairs } from "@/api/endpoints/trading";
import { IndicatorToolbar } from "./IndicatorToolbar";
import AssetTab from "./AssetTab";
import type { Timeframe } from "@/api/endpoints/candles";
import type { TradingPair } from "@/types/api";

const TIMEFRAMES: Timeframe[] = ["1m", "5m", "15m", "1h", "4h", "1d", "1w"];

const TIMEFRAME_LABELS: Record<Timeframe, string> = {
  "1m": "1 minute",
  "5m": "5 minutes",
  "15m": "15 minutes",
  "1h": "1 hour",
  "4h": "4 hours",
  "1d": "1 day",
  "1w": "1 week",
};

/* ── Unified top toolbar CSS ──
   Injected once into <head>, same pattern as CandlestickChart's
   CONTEXT_BAR_CSS / TradingPage's TRADE_CSS. Bold, high-contrast — the
   old two-row header's thin/low-alpha text and icons are the thing this
   replaces. Reuses the tr-search and tr-asset-tab class families already
   defined in TradingPage's TRADE_CSS (the pair-search dropdown is
   unchanged, just re-anchored here). */
const TOOLBAR_CSS = `
  .tr-toolbar {
    display:flex;align-items:center;gap:10px;
    border-bottom:1px solid var(--border);
    background:rgba(4,4,4,0.97);flex-shrink:0;
    height:46px;padding:0 16px;
    position:relative;z-index:5;
    font-family:'Space Mono',monospace;
  }
  .tr-toolbar-divider {
    width:1px;height:24px;flex-shrink:0;
    background:rgba(255,255,255,0.1);
  }
  /* Profile avatar */
  .tr-tb-profile {
    width:30px;height:30px;border-radius:50%;flex-shrink:0;
    display:flex;align-items:center;justify-content:center;
    background:rgba(0,255,65,0.08);
    border:1px solid rgba(0,255,65,0.3);
    color:var(--g,#00ff41);font-weight:700;font-size:11px;letter-spacing:0.5px;
    cursor:pointer;transition:all 0.15s;
  }
  .tr-tb-profile:hover { background:rgba(0,255,65,0.16);color:#fff;border-color:var(--g,#00ff41); }
  /* Symbol search */
  .tr-tb-search-icon { color:rgba(255,255,255,0.85);flex-shrink:0;display:flex; }
  .tr-tb-search-wrap { display:flex;align-items:center;gap:6px;flex-shrink:0; }
  /* Timeframe buttons */
  .tr-tb-tf-group { display:flex;align-items:center;gap:4px; }
  .tr-tb-tf-btn {
    padding:5px 10px;font-size:12px;font-weight:700;border-radius:2px;
    transition:all 0.15s;font-family:'Space Mono',monospace;letterSpacing:1px;
    border:1px solid rgba(0,255,65,0.2);background:transparent;
    color:rgba(255,255,255,0.85);cursor:pointer;
  }
  .tr-tb-tf-btn:hover { background:rgba(0,255,65,0.1);color:#fff; }
  .tr-tb-tf-btn.active { border-color:#00ff41;background:#00ff41;color:#000; }
  .tr-tb-tf-picker-btn {
    display:flex;align-items:center;justify-content:center;
    width:24px;height:24px;border-radius:2px;flex-shrink:0;
    border:none;background:transparent;
    color:rgba(255,255,255,0.85);font-weight:700;cursor:pointer;transition:all 0.15s;
  }
  .tr-tb-tf-picker-btn:hover { background:rgba(0,255,65,0.1);color:#fff; }
  .tr-tb-tf-picker {
    position:absolute;top:calc(100% + 6px);z-index:20;
    min-width:160px;background:#080808;border:1px solid rgba(0,255,65,0.16);
    border-radius:2px;box-shadow:0 4px 20px rgba(0,0,0,0.6);padding:6px 0;
  }
  .tr-tb-tf-picker-row {
    display:flex;align-items:center;gap:8px;padding:5px 12px;
    cursor:pointer;width:100%;background:transparent;border:none;text-align:left;
  }
  .tr-tb-tf-picker-row:hover { background:rgba(0,255,65,0.1); }
  .tr-tb-tf-picker-label {
    font-size:12px;font-weight:700;color:rgba(255,255,255,0.85);
    font-family:'Space Mono',monospace;
  }
  .tr-tb-tf-picker-check {
    width:13px;height:13px;border-radius:2px;flex-shrink:0;
    display:flex;align-items:center;justify-content:center;
    border:1px solid rgba(255,255,255,0.25);
  }
  .tr-tb-tf-picker-check.checked { background:#00ff41;border-color:#00ff41; }
  /* Indicators + Alerts icons */
  .tr-tb-icon-btn {
    display:flex;align-items:center;justify-content:center;
    width:30px;height:30px;border-radius:2px;flex-shrink:0;
    border:1px solid rgba(0,255,65,0.2);background:transparent;
    color:rgba(255,255,255,0.92);font-weight:700;cursor:pointer;transition:all 0.15s;
  }
  .tr-tb-icon-btn:hover { background:rgba(0,255,65,0.1);color:#fff;border-color:var(--g,#00ff41); }
`;

interface TradeToolbarProps {
  timeframe: Timeframe;
  onTimeframeChange: (tf: Timeframe) => void;
  vpvrMode: "visible" | "weekly" | "daily";
  onVpvrModeChange: (mode: "visible" | "weekly" | "daily") => void;
}

export function TradeToolbar({ timeframe, onTimeframeChange, vpvrMode, onVpvrModeChange }: TradeToolbarProps) {
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const pairs = useAppStore((s) => s.pairs);
  const selectedPairId = useTradingStore((s) => s.selectedPairId);
  const selectPair = useTradingStore((s) => s.selectPair);
  const selectedPair = pairs.find((p) => p.id === selectedPairId);

  const initials = user?.displayName
    ? user.displayName.slice(0, 2).toUpperCase()
    : user?.email
      ? user.email.slice(0, 2).toUpperCase()
      : "??";

  // Inject toolbar CSS once.
  useEffect(() => {
    const id = "tradr-toolbar-css";
    if (!document.getElementById(id)) {
      const s = document.createElement("style");
      s.id = id;
      s.textContent = TOOLBAR_CSS;
      document.head.appendChild(s);
    }
  }, []);

  /* ── Symbol search — merged with the "active pair" display: shows the
     current symbol when idle, switches to a live filter-as-you-type search
     on focus, reverts to the symbol display on blur/selection. Ported from
     TradingPage.tsx's old .tr-abar pair search. ── */
  const [pairQuery, setPairQuery] = useState("");
  const [searchFocused, setSearchFocused] = useState(false);
  const [pairSearchResults, setPairSearchResults] = useState<TradingPair[] | null>(null);
  const [pairSearching, setPairSearching] = useState(false);
  const latestPairQueryRef = useRef("");

  useEffect(() => {
    const trimmed = pairQuery.trim();
    latestPairQueryRef.current = trimmed;

    if (!trimmed) {
      setPairSearchResults(null);
      setPairSearching(false);
      return;
    }

    setPairSearching(true);
    const timer = setTimeout(() => {
      searchPairs(trimmed)
        .then((res) => {
          if (latestPairQueryRef.current !== trimmed) return; // stale response
          setPairSearchResults(res.data.pairs);
        })
        .catch(() => {
          if (latestPairQueryRef.current !== trimmed) return;
          setPairSearchResults([]);
        })
        .finally(() => {
          if (latestPairQueryRef.current === trimmed) setPairSearching(false);
        });
    }, 250);

    return () => clearTimeout(timer);
  }, [pairQuery]);

  const isPairSearchActive = pairQuery.trim().length > 0;
  const displayValue = searchFocused ? pairQuery : selectedPair?.symbol ?? "";

  function handleSelectPair(pairId: string) {
    selectPair(pairId);
    setPairQuery("");
    setSearchFocused(false);
  }

  /* ── Timeframe customization picker — "+"/chevron opens a dropdown with a
     checkbox per supported timeframe to show/hide it from the pinned row.
     Component-local state only, not persisted (matches the task's "doesn't
     need to be fully save-persisted yet" allowance). ── */
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pinnedTfs, setPinnedTfs] = useState<Timeframe[]>([...TIMEFRAMES]);
  const pickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!pickerOpen) return;
    const handler = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) setPickerOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [pickerOpen]);

  function togglePinned(tf: Timeframe) {
    setPinnedTfs((prev) =>
      prev.includes(tf) ? prev.filter((t) => t !== tf) : TIMEFRAMES.filter((t) => prev.includes(t) || t === tf),
    );
  }

  return (
    <div className="tr-toolbar tr-fu">
      {/* 1 — Profile */}
      <button
        type="button"
        className="tr-tb-profile"
        onClick={() => navigate("/profile")}
        title="Profile"
        aria-label="Profile"
      >
        {initials}
      </button>

      <span className="tr-toolbar-divider" />

      {/* 2 — Symbol search (doubles as the active-symbol display when idle) */}
      <div className="tr-tb-search-wrap">
        <span className="tr-tb-search-icon" title="Symbol search" aria-hidden="true">
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="7" cy="7" r="4.5" />
            <line x1="10.5" y1="10.5" x2="14" y2="14" />
          </svg>
        </span>
        <div className="tr-search">
          <input
            type="text"
            value={displayValue}
            onChange={(e) => setPairQuery(e.target.value)}
            onFocus={() => { setSearchFocused(true); setPairQuery(""); }}
            onBlur={() => setSearchFocused(false)}
            placeholder="Search pairs..."
            title="Symbol search"
            className="tr-search-input"
            style={{ fontWeight: 700, color: "rgba(255,255,255,0.95)" }}
          />
          {isPairSearchActive && searchFocused && (
            <div className="tr-search-dropdown">
              {pairSearching && pairSearchResults === null ? (
                <div className="tr-search-msg">Loading...</div>
              ) : (pairSearchResults ?? []).length === 0 ? (
                <div className="tr-search-msg">No pairs found</div>
              ) : (
                (pairSearchResults ?? []).map((p) => (
                  <div
                    key={p.id}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => handleSelectPair(p.id)}
                  >
                    <AssetTab pairId={p.id} symbol={p.symbol} isActive={p.id === selectedPairId} />
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      </div>

      <span className="tr-toolbar-divider" />

      {/* 3 — Timeframes + customization picker */}
      <div className="tr-tb-tf-group">
        {pinnedTfs.map((tf) => (
          <button
            key={tf}
            type="button"
            className={`tr-tb-tf-btn${timeframe === tf ? " active" : ""}`}
            onClick={() => onTimeframeChange(tf)}
            title={TIMEFRAME_LABELS[tf]}
          >
            {tf}
          </button>
        ))}
        <div ref={pickerRef} style={{ position: "relative" }}>
          <button
            type="button"
            className="tr-tb-tf-picker-btn"
            onClick={() => setPickerOpen((v) => !v)}
            title="Customize timeframes"
            aria-label="Customize timeframes"
            aria-haspopup="menu"
            aria-expanded={pickerOpen}
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 6l4 4 4-4" />
            </svg>
          </button>
          {pickerOpen && (
            <div className="tr-tb-tf-picker" role="menu">
              {TIMEFRAMES.map((tf) => {
                const checked = pinnedTfs.includes(tf);
                return (
                  <button
                    key={tf}
                    type="button"
                    role="menuitemcheckbox"
                    aria-checked={checked}
                    className="tr-tb-tf-picker-row"
                    onClick={() => togglePinned(tf)}
                  >
                    <span className={`tr-tb-tf-picker-check${checked ? " checked" : ""}`}>
                      {checked && (
                        <svg width="9" height="9" viewBox="0 0 12 12" fill="none" stroke="#000" strokeWidth="2">
                          <path d="M2 6l3 3 5-5" />
                        </svg>
                      )}
                    </span>
                    <span className="tr-tb-tf-picker-label">{tf}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <span className="tr-toolbar-divider" style={{ marginLeft: "auto" }} />

      {/* 4 — Indicators */}
      <IndicatorToolbar vpvrMode={vpvrMode} onVpvrModeChange={onVpvrModeChange} />

      {/* 5 — Alerts (placeholder, no functionality yet) */}
      <button type="button" className="tr-tb-icon-btn" title="Alerts" aria-label="Alerts">
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="8" cy="8" r="6" />
          <path d="M8 4.5V8l2.5 1.5" />
        </svg>
      </button>
    </div>
  );
}
