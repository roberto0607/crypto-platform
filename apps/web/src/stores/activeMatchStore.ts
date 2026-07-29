import { create } from "zustand";
import { getActiveMatch, type Match } from "@/api/endpoints/matches";

interface ActiveMatchState {
    activeMatch: Match | null;
    isInCompetition: boolean;
    setActiveMatch: (m: Match | null) => void;
    refreshMatch: () => Promise<void>;
}

/**
 * Shared "is the user in an active 1v1 match" state. Previously hook-local
 * to useCompetitionMode, independently instantiated (independent poll timer,
 * independent state) at each of its call sites (useThemeDetector.ts,
 * TradingPage.tsx) -- promoted to a store so any component can read
 * activeMatch/isInCompetition without its own poll. Deliberately a separate
 * store from useCompetitionStore, which is the *weekly-competition* tier
 * system (different vocabulary, different lifecycle) -- conflating the two
 * would repeat the exact confusion docs/followups.md already flags between
 * those two tier systems.
 */
export const useActiveMatchStore = create<ActiveMatchState>((set) => ({
    activeMatch: null,
    isInCompetition: false,

    setActiveMatch: (m) => set({ activeMatch: m, isInCompetition: m?.status === "ACTIVE" }),

    refreshMatch: async () => {
        try {
            const { data } = await getActiveMatch();
            set({ activeMatch: data.match, isInCompetition: data.match?.status === "ACTIVE" });
        } catch {
            set({ activeMatch: null, isInCompetition: false });
        }
    },
}));

// ── Shared poll, refcounted across every useCompetitionMode() call site ──
// Only one setInterval ever runs regardless of how many components call
// useCompetitionMode simultaneously -- acquire/release balance around each
// mount/unmount so the timer starts on the first subscriber and stops on
// the last, independent of mount/unmount order between call sites.
const POLL_INTERVAL_MS = 30_000;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let subscriberCount = 0;

// Fast-path refresh on match.started/match.ended so isInCompetition/activeMatch
// (and anything reading them, e.g. the global competition bottom bar) update
// immediately instead of waiting up to POLL_INTERVAL_MS. Registered/torn down
// alongside the poll timer so they're only live while something's subscribed.
function handleMatchStarted(): void {
    void useActiveMatchStore.getState().refreshMatch();
}
function handleMatchEnded(): void {
    void useActiveMatchStore.getState().refreshMatch();
}

export function acquireActiveMatchPolling(): void {
    subscriberCount++;
    if (subscriberCount === 1 && !pollTimer) {
        pollTimer = setInterval(() => {
            void useActiveMatchStore.getState().refreshMatch();
        }, POLL_INTERVAL_MS);
        window.addEventListener("sse:match.started", handleMatchStarted);
        window.addEventListener("sse:match.ended", handleMatchEnded);
    }
}

export function releaseActiveMatchPolling(): void {
    subscriberCount = Math.max(0, subscriberCount - 1);
    if (subscriberCount === 0 && pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
        window.removeEventListener("sse:match.started", handleMatchStarted);
        window.removeEventListener("sse:match.ended", handleMatchEnded);
    }
}
