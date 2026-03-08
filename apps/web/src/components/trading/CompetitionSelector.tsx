import { useEffect } from "react";
import { useTradingStore } from "@/stores/tradingStore";
import { useCompetitionStore } from "@/stores/competitionStore";

export function CompetitionSelector() {
    const activeCompetitionId = useTradingStore((s) => s.activeCompetitionId);
    const setActiveCompetition = useTradingStore((s) => s.setActiveCompetition);
    const myCompetitions = useCompetitionStore((s) => s.myCompetitions);
    const fetchMyCompetitions = useCompetitionStore((s) => s.fetchMyCompetitions);

    useEffect(() => {
        fetchMyCompetitions();
    }, [fetchMyCompetitions]);

    // Only show active competitions the user is participating in
    const activeComps = (myCompetitions ?? []).filter(
        (c) => c.competition_status === "ACTIVE" && c.status === "ACTIVE",
    );

    return (
        <select
            value={activeCompetitionId ?? ""}
            onChange={(e) => setActiveCompetition(e.target.value || null)}
            className="bg-gray-800 text-white text-sm rounded px-3 py-1.5 border border-gray-700
                       focus:outline-none focus:border-blue-500"
        >
            <option value="">Free Play</option>
            {activeComps.map((c) => (
                <option key={c.competition_id} value={c.competition_id}>
                    {c.competition_name.startsWith("Weekly") ? `[Weekly] ${c.competition_name}` : c.competition_name}
                </option>
            ))}
        </select>
    );
}
