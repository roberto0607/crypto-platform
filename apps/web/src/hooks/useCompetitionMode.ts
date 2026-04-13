import { useState, useEffect, useCallback } from "react";
import { getActiveMatch, type Match } from "@/api/endpoints/matches";
import { useAuthStore } from "@/stores/authStore";

interface CompetitionMode {
    isInCompetition: boolean;
    activeMatch: Match | null;
    refreshMatch: () => Promise<void>;
}

/**
 * Hook that checks if the user has an active 1v1 match.
 * Theme switching is now handled by useThemeDetector via data-theme attribute.
 *
 * Gated on isAuthenticated — this hook is mounted at the App root via
 * useThemeDetector, so without the gate it would poll /v1/matches/active
 * on the login page and during auth init, producing 401s that cascade
 * through the refresh-retry interceptor and (since the refresh-401 fix
 * in a603c38) hard-redirect the user, which in turn tore down SSE.
 */
export function useCompetitionMode(): CompetitionMode {
    const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
    const [activeMatch, setActiveMatch] = useState<Match | null>(null);

    const refreshMatch = useCallback(async () => {
        if (!isAuthenticated) { setActiveMatch(null); return; }
        try {
            const { data } = await getActiveMatch();
            setActiveMatch(data.match);
        } catch {
            setActiveMatch(null);
        }
    }, [isAuthenticated]);

    useEffect(() => {
        if (!isAuthenticated) { setActiveMatch(null); return; }
        refreshMatch();
        // Poll every 30s for match status changes
        const interval = setInterval(refreshMatch, 30_000);
        return () => clearInterval(interval);
    }, [refreshMatch, isAuthenticated]);

    const isInCompetition = activeMatch?.status === "ACTIVE";

    return { isInCompetition, activeMatch, refreshMatch };
}
