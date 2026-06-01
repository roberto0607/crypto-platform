import type { SseConnectionState } from "@/api/sse";

interface MarketStatusBadgeProps {
  /** Current SSE connection lifecycle state. */
  status: SseConnectionState;
  /** True when connected but no price tick has arrived recently (>10s). */
  priceStale: boolean;
  /** True when a reconnect has been failing long enough (>60s) to give up on. */
  isHardOffline: boolean;
  /** Invoked by the hard-offline REFRESH button. */
  onRefresh: () => void;
}

interface BadgeView {
  color: string;
  dotClass: string;
  glow: boolean;
  label: string;
}

/**
 * Derive the badge's visual from the SSE state. The key invariant: the red
 * "OFFLINE" label only appears for `disconnected` (a connect that gave up) or
 * `isHardOffline` (a reconnect that gave up after 60s) — NEVER during the
 * cold-load `initializing`/`connecting` window, which is the flash this PR fixes.
 */
function deriveView(status: SseConnectionState, priceStale: boolean, isHardOffline: boolean): BadgeView {
  if (isHardOffline || status === "disconnected") {
    return { color: "#ef4444", dotClass: "bg-red-500", glow: false, label: "OFFLINE" };
  }
  if (status === "connected") {
    return priceStale
      ? { color: "#f59e0b", dotClass: "bg-yellow-500", glow: false, label: "RECONNECTING..." }
      : { color: "var(--theme-primary, #00ff41)", dotClass: "bg-tradr-green", glow: true, label: "MARKETS LIVE" };
  }
  if (status === "reconnecting") {
    return { color: "#f59e0b", dotClass: "bg-yellow-500", glow: false, label: "RECONNECTING..." };
  }
  if (status === "connecting") {
    return { color: "#22d3ee", dotClass: "bg-cyan-400", glow: false, label: "CONNECTING..." };
  }
  // initializing — neutral dot, no label (avoids a "connecting…" flash on fast loads)
  return { color: "rgba(255,255,255,0.35)", dotClass: "bg-white/30", glow: false, label: "" };
}

export function MarketStatusBadge({ status, priceStale, isHardOffline, onRefresh }: MarketStatusBadgeProps) {
  const view = deriveView(status, priceStale, isHardOffline);
  // Offer the manual remediation whenever we've given up — the 60s reconnect
  // hard-offline AND the 5s cold-load give-up both render "OFFLINE" and both
  // benefit from a one-click refresh. Keyed off the label, not the two paths.
  const showRefresh = isHardOffline || status === "disconnected";

  return (
    <div className="flex items-center gap-1.5 text-[9px] tracking-[2px] font-mono" style={{ color: view.color }}>
      <span
        className={`w-[5px] h-[5px] rounded-full animate-blink ${view.dotClass}`}
        style={view.glow ? { boxShadow: `0 0 6px var(--theme-primary, #00ff41)` } : undefined}
      />
      {view.label}
      {showRefresh && (
        <button
          type="button"
          onClick={onRefresh}
          className="ml-1.5 px-1.5 py-0.5 border border-red-500/60 text-red-400 hover:bg-red-500/10 tracking-[2px]"
        >
          REFRESH
        </button>
      )}
    </div>
  );
}
