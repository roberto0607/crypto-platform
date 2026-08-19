import { create } from "zustand";
import type { AgentDecisionEvent } from "@/types/api";

export interface AgentActivityEntry {
    id: string;
    ts: number;
    agentName: string;
    pairId: string | null;
    decision: string;
    reasoning: string | null;
    tradeProposalId: string | null;
    priceAtDecision: string | null;
}

interface AgentActivityState {
    entries: AgentActivityEntry[];
    panelOpen: boolean;
    newCount: number;

    addDecision: (data: AgentDecisionEvent, ts: number) => void;
    togglePanel: () => void;
    closePanel: () => void;
}

// Modeled on notificationStore.ts's shape: a capped array (100, same
// slice() technique) instead of a true ring buffer, and a plain "arrived
// since last opened" counter instead of per-item read state -- unlike
// notifications, agent_decisions has no "read" concept server-side, and
// this is a passive feed, not an actionable list. newCount resets to 0
// only when the panel transitions closed -> open (viewed), not on close.
export const useAgentActivityStore = create<AgentActivityState>((set) => ({
    entries: [],
    panelOpen: false,
    newCount: 0,

    addDecision(data, ts) {
        set((s) => ({
            entries: [
                { id: crypto.randomUUID(), ts, ...data },
                ...s.entries,
            ].slice(0, 100),
            newCount: s.panelOpen ? s.newCount : s.newCount + 1,
        }));
    },

    togglePanel() {
        set((s) => {
            const opening = !s.panelOpen;
            return { panelOpen: opening, newCount: opening ? 0 : s.newCount };
        });
    },

    closePanel() {
        set({ panelOpen: false });
    },
}));
