import { create } from "zustand";
import { forfeitMatch, getActiveMatch, getMatch, type Match } from "@/api/endpoints/matches";
import { coalesce } from "@/lib/coalesce";
import { setVisibleInterval } from "@/lib/visibleInterval";
import type { MatchEndedEvent, MatchPnlUpdateEvent } from "@/types/api";

export interface LivePnl {
    matchId: string;
    challengerPnlPct: string;
    opponentPnlPct: string;
}

export type TradeMode = "MATCH" | "PRACTICE";

interface ActiveMatchState {
    activeMatch: Match | null;
    isInCompetition: boolean;
    /** During a live match: trade it, or practice on free-play (lib/orderScope). */
    tradeMode: TradeMode;
    setTradeMode: (mode: TradeMode) => void;
    /** The latest match.pnl.update for activeMatch. Read through useMatchPnl. */
    livePnl: LivePnl | null;
    /** ends_at has passed and the server hasn't given the result yet. */
    settling: boolean;
    /** A finished match whose result the player hasn't dismissed. */
    endedMatch: Match | null;
    /** Sets the match; null also clears the session (logout). */
    setActiveMatch: (m: Match | null) => void;
    refreshMatch: () => Promise<void>;
    /** Rejects if the forfeit failed. */
    forfeit: (matchId: string) => Promise<void>;
    dismissEndedMatch: () => void;
}

/**
 * The user's 1v1 session: which match is on, its live P&L, and how it ended.
 * One copy for every screen, fed by four sources that can arrive in any
 * order: match.ended (fast path), the 30s poll, the refetch after an SSE
 * reconnect (the bus has no replay), and a timer at ends_at.
 *
 * Deliberately a separate store from useCompetitionStore, which is the
 * *weekly-competition* tier system (different vocabulary, different
 * lifecycle) -- conflating the two would repeat the exact confusion
 * docs/followups.md already flags between those two tier systems.
 */
// Every useCompetitionMode() caller refreshes on mount (3 on /trade); share one request.
const fetchActiveMatch = coalesce(() => getActiveMatch());

const POLL_INTERVAL_MS = 30_000;
/** How often to ask for the result once ends_at has passed (matchCleanupJob completes it within ~15 s). */
const SETTLE_POLL_MS = 5_000;
/** setTimeout overflows past 2^31 ms (~24.8 days). */
const MAX_TIMER_MS = 2_000_000_000;

// A poll that left before the match ended can answer after it: this match is
// over whatever that answer says.
let lastEndedMatchId: string | null = null;
let endTimer: ReturnType<typeof setTimeout> | undefined;
let settlePoll: ReturnType<typeof setInterval> | undefined;

const isResult = (m: Match) => m.status === "COMPLETED" || m.status === "FORFEITED";

function stopSettlePoll(): void {
    clearInterval(settlePoll);
    settlePoll = undefined;
}

/** Keeps `settling` and the ends_at timer in step with the current match. */
function watchEnd(): void {
    clearTimeout(endTimer);
    const { activeMatch, settling } = useActiveMatchStore.getState();
    const endsAt = activeMatch?.status === "ACTIVE" && activeMatch.ends_at
        ? new Date(activeMatch.ends_at).getTime()
        : null;
    const msLeft = endsAt === null ? null : endsAt - Date.now();

    if (msLeft !== null && msLeft <= 0) {
        if (!settling) useActiveMatchStore.setState({ settling: true });
        settlePoll ??= setInterval(() => { void useActiveMatchStore.getState().refreshMatch(); }, SETTLE_POLL_MS);
        return;
    }
    stopSettlePoll();
    if (settling) useActiveMatchStore.setState({ settling: false });
    if (msLeft !== null) endTimer = setTimeout(watchEnd, Math.min(msLeft, MAX_TIMER_MS));
}

function applyMatch(match: Match | null): void {
    useActiveMatchStore.setState((s) => ({
        activeMatch: match,
        isInCompetition: match?.status === "ACTIVE",
        // A stale number from a prior match can't leak.
        livePnl: s.livePnl?.matchId === match?.id ? s.livePnl : null,
        // Every match starts on the match, whatever the last one was left on.
        tradeMode: s.activeMatch?.id === match?.id ? s.tradeMode : "MATCH",
    }));
    watchEnd();
}

function finishMatch(match: Match): void {
    lastEndedMatchId = match.id;
    useActiveMatchStore.setState({ endedMatch: match });
    if (useActiveMatchStore.getState().activeMatch?.id === match.id) applyMatch(null);
}

export const useActiveMatchStore = create<ActiveMatchState>((set, get) => ({
    activeMatch: null,
    isInCompetition: false,
    tradeMode: "MATCH",
    setTradeMode: (tradeMode) => set({ tradeMode }),
    livePnl: null,
    settling: false,
    endedMatch: null,

    setActiveMatch: (m) => {
        if (m === null) {
            lastEndedMatchId = null;
            set({ endedMatch: null });
        }
        applyMatch(m);
    },

    refreshMatch: async () => {
        let match: Match | null;
        try {
            match = (await fetchActiveMatch()).data.match;
        } catch {
            return; // a failed poll says nothing about the match
        }
        if (match?.id === lastEndedMatchId) match = null;

        const prev = get().activeMatch;
        if (prev?.status === "ACTIVE" && match?.id !== prev.id) {
            try {
                const final = (await getMatch(prev.id)).data.match;
                if (isResult(final)) finishMatch(final);
                else if (final.status === "ACTIVE") return; // the two reads crossed: the next poll settles it
            } catch {
                // Result unknown: keep the match for the next poll, unless a new one has started.
                if (!match) return;
            }
        }
        applyMatch(match);
    },

    forfeit: async (matchId) => {
        await forfeitMatch(matchId);
        try {
            // The full row, with JOINed names and ELO, for the result screen.
            finishMatch((await getMatch(matchId)).data.match);
        } catch {
            void get().refreshMatch(); // forfeited all the same: match.ended or the poll brings the result
        }
    },

    dismissEndedMatch: () => set({ endedMatch: null }),
}));

/** Both players' P&L %: the latest push, else the match's own (live on read). */
export function matchPnl(match: Match, live: LivePnl | null): { challengerPnlPct: string | null; opponentPnlPct: string | null } {
    const push = live?.matchId === match.id ? live : null;
    return {
        challengerPnlPct: push?.challengerPnlPct ?? match.challenger_pnl_pct,
        opponentPnlPct: push?.opponentPnlPct ?? match.opponent_pnl_pct,
    };
}

export function useMatchPnl(match: Match | null): { challengerPnlPct: string | null; opponentPnlPct: string | null } {
    const live = useActiveMatchStore((s) => s.livePnl);
    return match ? matchPnl(match, live) : { challengerPnlPct: null, opponentPnlPct: null };
}

// ── Shared poll and SSE listeners, refcounted across every useCompetitionMode() call site ──
// Only one setInterval ever runs regardless of how many components call
// useCompetitionMode simultaneously -- acquire/release balance around each
// mount/unmount so the timer starts on the first subscriber and stops on
// the last, independent of mount/unmount order between call sites.
let stopPoll: (() => void) | null = null;
let subscriberCount = 0;

function handleRefresh(): void {
    void useActiveMatchStore.getState().refreshMatch();
}

function handlePnlUpdate(e: Event): void {
    const d = (e as CustomEvent<MatchPnlUpdateEvent>).detail;
    const { activeMatch } = useActiveMatchStore.getState();
    if (!d || d.matchId !== activeMatch?.id) return;
    useActiveMatchStore.setState({
        livePnl: { matchId: d.matchId, challengerPnlPct: d.challengerPnlPct, opponentPnlPct: d.opponentPnlPct },
    });
}

/** The verdict from the push: no refetch needed, and spectated matches don't match. */
function handleMatchEnded(e: Event): void {
    const d = (e as CustomEvent<MatchEndedEvent>).detail;
    const { activeMatch } = useActiveMatchStore.getState();
    if (d && d.matchId === activeMatch?.id) {
        finishMatch({
            ...activeMatch,
            status: d.reason === "timeout" ? "COMPLETED" : "FORFEITED",
            winner_id: d.winnerUserId,
            forfeit_user_id: d.forfeitUserId,
            challenger_pnl_pct: d.challengerPnlPct,
            opponent_pnl_pct: d.opponentPnlPct,
            elo_delta: d.eloDeltas?.winner ?? activeMatch.elo_delta,
        });
    }
    handleRefresh();
}

export function acquireActiveMatchPolling(): void {
    subscriberCount++;
    if (subscriberCount === 1 && !stopPoll) {
        // Paused while the tab is hidden; SSE match.started/ended still land.
        stopPoll = setVisibleInterval(handleRefresh, POLL_INTERVAL_MS);
        window.addEventListener("sse:match.started", handleRefresh);
        // A challenge sent to you, or yours declined / withdrawn: the
        // receiver card on every page reads this store.
        window.addEventListener("sse:challenge.received", handleRefresh);
        window.addEventListener("sse:challenge.closed", handleRefresh);
        window.addEventListener("sse:reconnected", handleRefresh);
        window.addEventListener("sse:match.ended", handleMatchEnded);
        window.addEventListener("sse:match.pnl.update", handlePnlUpdate);
    }
}

export function releaseActiveMatchPolling(): void {
    subscriberCount = Math.max(0, subscriberCount - 1);
    if (subscriberCount === 0 && stopPoll) {
        stopPoll();
        stopPoll = null;
        window.removeEventListener("sse:match.started", handleRefresh);
        window.removeEventListener("sse:challenge.received", handleRefresh);
        window.removeEventListener("sse:challenge.closed", handleRefresh);
        window.removeEventListener("sse:reconnected", handleRefresh);
        window.removeEventListener("sse:match.ended", handleMatchEnded);
        window.removeEventListener("sse:match.pnl.update", handlePnlUpdate);
    }
}
