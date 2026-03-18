import { useState, useEffect, useCallback } from "react";
import { getActiveMatch, type Match } from "@/api/endpoints/matches";

interface CompetitionMode {
    isInCompetition: boolean;
    activeMatch: Match | null;
    refreshMatch: () => Promise<void>;
}

/**
 * Hook that checks if the user has an active 1v1 match.
 * Theme switching is now handled by useThemeDetector via data-theme attribute.
 */
export function useCompetitionMode(): CompetitionMode {
    const [activeMatch, setActiveMatch] = useState<Match | null>(null);

    const refreshMatch = useCallback(async () => {
        try {
            const { data } = await getActiveMatch();
            setActiveMatch(data.match);
        } catch {
            setActiveMatch(null);
        }
    }, []);

    useEffect(() => {
        refreshMatch();
        // Poll every 30s for match status changes
        const interval = setInterval(refreshMatch, 30_000);
        return () => clearInterval(interval);
    }, [refreshMatch]);

    const isInCompetition = activeMatch?.status === "ACTIVE";

    return { isInCompetition, activeMatch, refreshMatch };
}
