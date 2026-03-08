import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useCompetitionStore } from "@/stores/competitionStore";
import { TierBadge } from "@/components/competitions/TierBadge";
import type { Competition } from "@/api/endpoints/competitions";

const TIERS = ["ROOKIE", "TRADER", "SPECIALIST", "EXPERT", "MASTER", "LEGEND"];
type StatusTab = "UPCOMING" | "ACTIVE" | "ENDED";
type TypeFilter = "ALL" | "WEEKLY" | "CUSTOM";

export default function CompetitionsPage() {
    const [activeTab, setActiveTab] = useState<StatusTab>("ACTIVE");
    const [typeFilter, setTypeFilter] = useState<TypeFilter>("ALL");
    const navigate = useNavigate();

    const {
        competitions, listLoading, fetchCompetitions,
        currentWeekly, currentWeeklyJoined, userTier, weeklyLoading,
        userBadges,
        fetchCurrentWeekly, fetchUserBadges,
        join,
    } = useCompetitionStore();

    useEffect(() => {
        fetchCurrentWeekly();
        fetchUserBadges();
    }, [fetchCurrentWeekly, fetchUserBadges]);

    useEffect(() => {
        fetchCompetitions({
            status: activeTab,
            competition_type: typeFilter === "ALL" ? undefined : typeFilter,
            limit: 50,
        });
    }, [activeTab, typeFilter, fetchCompetitions]);

    const tabs: StatusTab[] = ["UPCOMING", "ACTIVE", "ENDED"];
    const typeFilters: TypeFilter[] = ["ALL", "WEEKLY", "CUSTOM"];

    const [joining, setJoining] = useState(false);
    const handleJoinWeekly = async () => {
        if (!currentWeekly) return;
        setJoining(true);
        try {
            await join(currentWeekly.id);
            navigate(`/competitions/${currentWeekly.id}`);
        } catch {
        } finally {
            setJoining(false);
        }
    };

    return (
        <div className="max-w-4xl mx-auto">
            {/* ═══ Weekly Competition Hero ═══ */}
            <WeeklyHero
                competition={currentWeekly}
                joined={currentWeeklyJoined}
                tier={userTier}
                badges={userBadges}
                loading={weeklyLoading}
                joining={joining}
                onJoin={handleJoinWeekly}
            />

            {/* ═══ All Competitions ═══ */}
            <h2 className="text-xl font-bold text-white mb-4">All Competitions</h2>

            <div className="flex items-center gap-4 mb-6">
                {/* Status tabs */}
                <div className="flex gap-1 bg-gray-900 rounded-lg p-1">
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

                {/* Type filter */}
                <div className="flex gap-1 bg-gray-900 rounded-lg p-1">
                    {typeFilters.map((f) => (
                        <button
                            key={f}
                            onClick={() => setTypeFilter(f)}
                            className={`px-3 py-2 rounded text-xs font-medium transition-colors ${
                                typeFilter === f
                                    ? "bg-gray-700 text-white"
                                    : "text-gray-400 hover:text-gray-200"
                            }`}
                        >
                            {f}
                        </button>
                    ))}
                </div>
            </div>

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

// ── Weekly Hero Section ──

function WeeklyHero({
    competition,
    joined,
    tier,
    badges,
    loading,
    joining,
    onJoin,
}: {
    competition: Competition | null;
    joined: boolean;
    tier: string;
    badges: Array<{ badge_type: string; tier: string; week_id: string }>;
    loading: boolean;
    joining: boolean;
    onJoin: () => void;
}) {
    if (loading) {
        return (
            <div className="bg-gray-900 border border-gray-800 rounded-lg p-8 mb-8 text-center text-gray-500">
                Loading weekly competition...
            </div>
        );
    }

    const now = Date.now();
    const endMs = competition ? new Date(competition.end_at).getTime() : 0;
    const startMs = competition ? new Date(competition.start_at).getTime() : 0;
    const isActive = competition?.status === "ACTIVE";
    const isUpcoming = competition?.status === "UPCOMING";
    const timeRemaining = isActive ? endMs - now : isUpcoming ? startMs - now : 0;

    const formatTime = (ms: number) => {
        if (ms <= 0) return "0s";
        const h = Math.floor(ms / 3_600_000);
        const m = Math.floor((ms % 3_600_000) / 60_000);
        if (h > 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
        if (h > 0) return `${h}h ${m}m`;
        return `${m}m`;
    };

    const championBadges = badges.filter((b) => b.badge_type === "WEEKLY_CHAMPION");

    return (
        <div className="bg-gradient-to-br from-gray-900 to-gray-950 border border-gray-800 rounded-lg p-6 mb-8">
            {/* Tier header */}
            <div className="flex items-center gap-3 mb-4">
                <span className="text-sm text-gray-400">Your Tier:</span>
                <TierBadge tier={tier} />
            </div>

            {/* Tier progress bar */}
            <div className="flex items-center gap-2 mb-6">
                {TIERS.map((t, i) => {
                    const isCurrent = t === tier;
                    const isPast = TIERS.indexOf(tier) > i;
                    return (
                        <div key={t} className="flex items-center gap-2">
                            <div className="flex flex-col items-center">
                                <div
                                    className={`w-3 h-3 rounded-full border-2 ${
                                        isCurrent
                                            ? "border-blue-400 bg-blue-400"
                                            : isPast
                                              ? "border-gray-500 bg-gray-500"
                                              : "border-gray-700 bg-transparent"
                                    }`}
                                />
                                <span className={`text-[10px] mt-1 ${isCurrent ? "text-blue-400 font-medium" : "text-gray-600"}`}>
                                    {t.slice(0, 2)}
                                </span>
                            </div>
                            {i < TIERS.length - 1 && (
                                <div className={`w-6 h-0.5 -mt-3 ${isPast ? "bg-gray-500" : "bg-gray-800"}`} />
                            )}
                        </div>
                    );
                })}
            </div>

            {/* Competition card */}
            {competition ? (
                <div className="bg-gray-800/50 border border-gray-700 rounded-lg p-5">
                    <div className="flex items-start justify-between mb-3">
                        <h3 className="text-lg font-semibold text-white">{competition.name}</h3>
                        {timeRemaining > 0 && (
                            <span className="text-sm text-blue-400">
                                {isUpcoming ? "Starts in " : "Ends in "}
                                {formatTime(timeRemaining)}
                            </span>
                        )}
                    </div>

                    <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-gray-400 mb-4">
                        <span>${Number(competition.starting_balance_usd).toLocaleString()} starting balance</span>
                        <span>BTC, ETH, SOL</span>
                        <span>Min 5 trades to qualify</span>
                        <span>Top 20% rank up</span>
                    </div>

                    {joined ? (
                        <Link
                            to={`/competitions/${competition.id}`}
                            className="inline-block bg-gray-700 hover:bg-gray-600 text-white px-6 py-2.5 rounded text-sm font-medium transition-colors"
                        >
                            View Leaderboard
                        </Link>
                    ) : (isActive || isUpcoming) ? (
                        <button
                            onClick={onJoin}
                            disabled={joining}
                            className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-2.5 rounded text-sm font-medium transition-colors disabled:opacity-50"
                        >
                            {joining ? "Joining..." : "Join This Week's Challenge"}
                        </button>
                    ) : null}
                </div>
            ) : (
                <div className="text-gray-500 text-sm">
                    Next weekly competition starts Monday at 00:00 UTC.
                </div>
            )}

            {/* Badges */}
            {championBadges.length > 0 && (
                <div className="mt-4 flex items-center gap-2 flex-wrap">
                    <span className="text-sm text-gray-400">Badges:</span>
                    {championBadges.map((b) => (
                        <span
                            key={b.week_id + b.tier}
                            className="inline-flex items-center gap-1 bg-yellow-900/30 text-yellow-400 text-xs px-2 py-0.5 rounded"
                        >
                            <span>&#x1F3C6;</span> Champion ({b.tier} - {b.week_id})
                        </span>
                    ))}
                </div>
            )}
        </div>
    );
}

// ── Competition Card ──

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
                <div className="flex items-center gap-2">
                    <h3 className="text-lg font-semibold text-white">{c.name}</h3>
                    {c.competition_type === "WEEKLY" && c.tier && (
                        <TierBadge tier={c.tier} size="sm" />
                    )}
                </div>
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
