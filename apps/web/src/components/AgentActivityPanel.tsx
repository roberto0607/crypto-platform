import { useEffect, useRef } from "react";
import { useAgentActivityStore, type AgentActivityEntry } from "@/stores/agentActivityStore";
import { useAppStore } from "@/stores/appStore";

function timeAgo(ts: number): string {
    const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (diffSec < 5) return "just now";
    if (diffSec < 60) return `${diffSec}s ago`;
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    const diffDay = Math.floor(diffHr / 24);
    return `${diffDay}d ago`;
}

// Color/severity tier per decision value. recovery_also_failed is
// deliberately NOT grouped with rejected/execution_failed's plain red/amber
// -- it's the one outcome that triggers the human email alert
// (alertHumanOnRecoveryFailure, executor.ts): a position left open and
// UNPROTECTED after both the original protection attempt AND the
// crash-recovery retry failed. It gets its own tag + row styling so it
// reads as categorically more urgent than an ordinary rejection at a
// glance, without requiring anyone to read the reasoning text.
const DECISION_STYLE: Record<string, { label: string; className: string }> = {
    approved: { label: "APPROVED", className: "text-tradr-green" },
    executed: { label: "EXECUTED", className: "text-tradr-green" },
    rejected: { label: "REJECTED", className: "text-yellow-400" },
    execution_failed: { label: "EXECUTION FAILED", className: "text-red-400" },
    expired: { label: "EXPIRED", className: "text-white/40" },
    auto_flattened: { label: "AUTO-FLATTENED", className: "text-white/40" },
    recovery_also_failed: { label: "RECOVERY FAILED", className: "text-red-300 font-bold" },
};

function AgentActivityEntryRow({ entry }: { entry: AgentActivityEntry }) {
    const pairs = useAppStore((s) => s.pairs);
    const pairSymbol = entry.pairId ? pairs.find((p) => p.id === entry.pairId)?.symbol : null;
    const style = DECISION_STYLE[entry.decision] ?? { label: entry.decision.toUpperCase(), className: "text-white/40" };
    const critical = entry.decision === "recovery_also_failed";

    return (
        <div className={`px-4 py-3 border-b border-gray-800/50 ${critical ? "bg-red-500/10 border-l-2 border-l-red-500" : ""}`}>
            <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] tracking-[1px] text-white/50 font-mono uppercase">{entry.agentName}</span>
                <span className="text-[9px] text-white/30 font-mono">{timeAgo(entry.ts)}</span>
            </div>
            <div className="flex items-center gap-2 mt-1 flex-wrap">
                <span className={`text-[10px] tracking-[1px] font-mono font-semibold ${style.className}`}>{style.label}</span>
                {pairSymbol && <span className="text-[10px] text-white/40 font-mono">{pairSymbol}</span>}
                {critical && (
                    <span className="text-[9px] tracking-[1px] font-mono px-1.5 py-0.5 bg-red-500/20 text-red-300 border border-red-500/40">
                        ⚠ NEEDS ATTENTION
                    </span>
                )}
            </div>
            {entry.reasoning && (
                <p className="text-xs text-gray-400 mt-1.5 leading-snug">{entry.reasoning}</p>
            )}
        </div>
    );
}

// Self-contained, no props -- mirrors NotificationBell.tsx's architecture
// (reads panelOpen/togglePanel/closePanel straight from the store, mounts
// unconditionally). Visually modeled on LiveMatchView's MatchChatPanel
// (floating overlay, opacity/visibility-toggled, kept mounted) but as
// Tailwind utilities rather than an embedded <style> block, since this
// component has no parent to lean on for shared CSS the way MatchChatPanel
// does. Mounted in AppLayout.tsx OUTSIDE the isTradePage-conditional
// topbar (unlike NotificationBell, which that topbar hides on /trade) so
// it's reachable from every route, /trade included.
export function AgentActivityPanel() {
    const { entries, panelOpen, newCount, togglePanel, closePanel } = useAgentActivityStore();
    const panelRef = useRef<HTMLDivElement>(null);

    // Outside-click-to-close — same pattern as NotificationBell.
    useEffect(() => {
        if (!panelOpen) return;
        const handler = (e: MouseEvent) => {
            if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
                closePanel();
            }
        };
        document.addEventListener("mousedown", handler);
        return () => document.removeEventListener("mousedown", handler);
    }, [panelOpen, closePanel]);

    return (
        <div ref={panelRef}>
            <button
                type="button"
                onClick={togglePanel}
                aria-label="Agent Activity"
                className="fixed bottom-4 right-4 z-[501] w-10 h-10 rounded-full bg-[#080808] border border-tradr-green/30 text-white/60 hover:text-tradr-green hover:border-tradr-green/60 transition-colors flex items-center justify-center"
            >
                <span className="text-base leading-none">◎</span>
                {newCount > 0 && (
                    <span className="absolute -top-1 -right-1 bg-red-500 text-white text-[10px] font-bold rounded-full w-4 h-4 flex items-center justify-center">
                        {newCount > 9 ? "9+" : newCount}
                    </span>
                )}
            </button>

            <div
                aria-hidden={!panelOpen}
                className={`fixed bottom-[68px] right-4 z-[500] w-80 h-[420px] max-h-[calc(100%-88px)] bg-[#080808] border border-tradr-green/30 shadow-[0_8px_24px_rgba(0,0,0,0.5)] flex flex-col transition-[opacity,transform,visibility] duration-150 ${
                    panelOpen ? "opacity-100 visible translate-y-0 pointer-events-auto" : "opacity-0 invisible translate-y-3 pointer-events-none"
                }`}
            >
                <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
                    <span className="text-[10px] tracking-[2px] text-white/50 font-mono uppercase">Agent Activity</span>
                    <button type="button" onClick={closePanel} aria-label="Close" className="text-white/30 hover:text-white/70 text-lg leading-none">
                        ×
                    </button>
                </div>
                <div className="overflow-y-auto flex-1">
                    {entries.length === 0 ? (
                        <div className="text-gray-500 text-sm text-center py-8">No agent activity yet</div>
                    ) : (
                        entries.map((e) => <AgentActivityEntryRow key={e.id} entry={e} />)
                    )}
                </div>
            </div>
        </div>
    );
}
