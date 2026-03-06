import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useCompetitionStore } from "@/stores/competitionStore";
import type { Competition } from "@/api/endpoints/competitions";

type StatusTab = "UPCOMING" | "ACTIVE" | "ENDED";

export default function CompetitionsPage() {
    const [activeTab, setActiveTab] = useState<StatusTab>("ACTIVE");
    const { competitions, listLoading, fetchCompetitions } = useCompetitionStore();

    useEffect(() => {
        fetchCompetitions({ status: activeTab, limit: 50 });
    }, [activeTab, fetchCompetitions]);

    const tabs: StatusTab[] = ["UPCOMING", "ACTIVE", "ENDED"];

    return (
        <div className="max-w-4xl mx-auto">
            <h1 className="text-2xl font-bold text-white mb-6">Competitions</h1>

            {/* Tab bar */}
            <div className="flex gap-1 mb-6 bg-gray-900 rounded-lg p-1 w-fit">
                {tabs.map((tab) => (
                    <button
                        key={tab}
                        onClick={() => setActiveTab(tab)}
                        className={`px-4 py-2 rounded text-sm font-medium transition-colors ${
                            activeTab === tab
                                ? "bg-gray-700 text-white"
                                : "text-gray-400 hover:text-gray-200"
                        }`}
                    >
                        {tab}
                    </button>
                ))}
            </div>

            {/* Competition cards */}
            {listLoading ? (
                <div className="text-gray-400 text-center py-12">Loading...</div>
            ) : competitions.length === 0 ? (
                <div className="text-gray-500 text-center py-12">
                    No {activeTab.toLowerCase()} competitions
                </div>
            ) : (
                <div className="grid gap-4">
                    {competitions.map((comp) => (
                        <CompetitionCard key={comp.id} competition={comp} />
                    ))}
                </div>
            )}
        </div>
    );
}

function CompetitionCard({ competition: c }: { competition: Competition }) {
    const statusColors: Record<string, string> = {
        UPCOMING: "text-yellow-400 bg-yellow-900/30",
        ACTIVE: "text-green-400 bg-green-900/30",
        ENDED: "text-gray-400 bg-gray-800",
        CANCELLED: "text-red-400 bg-red-900/30",
    };

    return (
        <Link
            to={`/competitions/${c.id}`}
            className="block bg-gray-900 border border-gray-800 rounded-lg p-5 hover:border-gray-600 transition-colors"
        >
            <div className="flex items-start justify-between mb-3">
                <h3 className="text-lg font-semibold text-white">{c.name}</h3>
                <span className={`text-xs px-2 py-1 rounded ${statusColors[c.status]}`}>
                    {c.status}
                </span>
            </div>
            {c.description && (
                <p className="text-gray-400 text-sm mb-3">{c.description}</p>
            )}
            <div className="flex gap-6 text-xs text-gray-500">
                <span>Starts: {new Date(c.start_at).toLocaleDateString()}</span>
                <span>Ends: {new Date(c.end_at).toLocaleDateString()}</span>
                <span>Balance: ${Number(c.starting_balance_usd).toLocaleString()}</span>
                {c.max_participants && <span>Max: {c.max_participants} players</span>}
            </div>
        </Link>
    );
}
