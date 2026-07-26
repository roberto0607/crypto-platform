import { useEffect } from "react";
import type { Match } from "@/api/endpoints/matches";
import { useAuthStore } from "@/stores/authStore";
import {
    useActiveMatchStore,
    acquireActiveMatchPolling,
    releaseActiveMatchPolling,
} from "@/stores/activeMatchStore";

interface CompetitionMode {
    isInCompetition: boolean;
    activeMatch: Match | null;
    refreshMatch: () => Promise<void>;
}

/**
 * Hook that checks if the user has an active 1v1 match. Thin wrapper around
 * activeMatchStore — state lives in the shared store, this hook just owns
 * the poll lifecycle (refcounted across every call site via
 * acquire/releaseActiveMatchPolling, so multiple simultaneous callers
 * — useThemeDetector, TradingPage — share a single 30s timer instead of
 * each running their own). Theme switching is handled by useThemeDetector
 * via data-theme attribute.
 *
 * Gated on isAuthenticated — this hook is mounted at the App root via
 * useThemeDetector, so without the gate it would poll /v1/matches/active
 * on the login page and during auth init, producing 401s that cascade
 * through the refresh-retry interceptor and (since the refresh-401 fix
 * in a603c38) hard-redirect the user, which in turn tore down SSE.
 */
export function useCompetitionMode(): CompetitionMode {
    const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
    const activeMatch = useActiveMatchStore((s) => s.activeMatch);
    const isInCompetition = useActiveMatchStore((s) => s.isInCompetition);
    const refreshMatch = useActiveMatchStore((s) => s.refreshMatch);
    const setActiveMatch = useActiveMatchStore((s) => s.setActiveMatch);

    useEffect(() => {
        if (!isAuthenticated) { setActiveMatch(null); return; }

        void refreshMatch();
        acquireActiveMatchPolling();
        return () => releaseActiveMatchPolling();
    }, [isAuthenticated, refreshMatch, setActiveMatch]);

    return { isInCompetition, activeMatch, refreshMatch };
}
