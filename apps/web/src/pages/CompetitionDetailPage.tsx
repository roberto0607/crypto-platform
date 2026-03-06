import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { useCompetitionStore } from "@/stores/competitionStore";
import { useAuthStore } from "@/stores/authStore";
import {
    ResponsiveContainer,
    LineChart,
    Line,
    XAxis,
    YAxis,
    Tooltip,
    CartesianGrid,
} from "recharts";
import { format } from "date-fns";
import {
    getCompetitionEquityCurve,
    getCompetitionComparison,
    type ComparisonParticipant,
} from "@/api/endpoints/competitions";
import { ComparisonChart } from "@/components/competitions/ComparisonChart";

export default function CompetitionDetailPage() {
    const { id } = useParams<{ id: string }>();
    const {
        detail, detailLoading, fetchDetail,
        leaderboard, leaderboardLoading, fetchLeaderboard,
        join, withdraw,
    } = useCompetitionStore();
    const userId = useAuthStore((s) => s.user?.id);
    const [joining, setJoining] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [equityCurve, setEquityCurve] = useState<Array<{ ts: number; equity: number }>>([]);
    const [comparison, setComparison] = useState<ComparisonParticipant[]>([]);

    useEffect(() => {
        if (id) {
            fetchDetail(id);
            fetchLeaderboard(id);

            getCompetitionEquityCurve(id, 500)
                .then(({ data }) => {
                    setEquityCurve(
                        data.snapshots.map((s) => ({
                            ts: s.ts,
                            equity: parseFloat(s.equity_quote),
                        })),
                    );
                })
                .catch(() => {});

            getCompetitionComparison(id, 5)
                .then(({ data }) => setComparison(data.participants))
                .catch(() => {});
        }
    }, [id, fetchDetail, fetchLeaderboard]);

    if (detailLoading || !detail) {
        return <div className="text-gray-400 text-center py-12">Loading...</div>;
    }

    const isActive = detail.status === "ACTIVE";
    const isUpcoming = detail.status === "UPCOMING";
    const canJoin = isActive || isUpcoming;

    // Countdown timer
    const now = Date.now();
    const endMs = new Date(detail.end_at).getTime();
    const startMs = new Date(detail.start_at).getTime();
    const timeRemaining = isActive ? endMs - now : isUpcoming ? startMs - now : 0;

    const formatTime = (ms: number) => {
        if (ms <= 0) return "0s";
        const h = Math.floor(ms / 3_600_000);
        const m = Math.floor((ms % 3_600_000) / 60_000);
        if (h > 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
        if (h > 0) return `${h}h ${m}m`;
        return `${m}m`;
    };

    const handleJoin = async () => {
        if (!id) return;
        setJoining(true);
        setError(null);
        try {
            await join(id);
            fetchLeaderboard(id);
        } catch (err: any) {
            setError(err.response?.data?.error ?? "Failed to join");
        } finally {
            setJoining(false);
        }
    };

    const handleWithdraw = async () => {
        if (!id || !confirm("Withdraw from this competition? Your orders will be canceled.")) return;
        try {
            await withdraw(id);
        } catch (err: any) {
            setError(err.response?.data?.error ?? "Failed to withdraw");
        }
    };

    return (
        <div className="max-w-4xl mx-auto">
            {/* Header */}
            <div className="mb-6">
                <h1 className="text-2xl font-bold text-white mb-2">{detail.name}</h1>
                {detail.description && (
                    <p className="text-gray-400">{detail.description}</p>
                )}
                <div className="flex gap-6 mt-3 text-sm text-gray-500">
                    <span>Starting balance: ${Number(detail.starting_balance_usd).toLocaleString()}</span>
                    {timeRemaining > 0 && (
                        <span className="text-blue-400">
                            {isUpcoming ? "Starts in " : "Ends in "}
                            {formatTime(timeRemaining)}
                        </span>
                    )}
                </div>
            </div>

            {/* Join / Withdraw buttons */}
            {canJoin && (
                <div className="mb-6 flex gap-3">
                    <button
                        onClick={handleJoin}
                        disabled={joining}
                        className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-2 rounded text-sm font-medium disabled:opacity-50"
                    >
                        {joining ? "Joining..." : "Join Competition"}
                    </button>
                    <button
                        onClick={handleWithdraw}
                        className="bg-gray-700 hover:bg-gray-600 text-gray-300 px-4 py-2 rounded text-sm"
                    >
                        Withdraw
                    </button>
                    {error && <span className="text-red-400 text-sm self-center">{error}</span>}
                </div>
            )}

            {/* Your Equity Curve */}
            {equityCurve.length > 0 && (
                <div className="bg-gray-900 border border-gray-800 rounded-lg p-5 mb-6">
                    <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wider mb-4">
                        Your Equity
                    </h2>
                    <ResponsiveContainer width="100%" height={250}>
                        <LineChart data={equityCurve}>
                            <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                            <XAxis
                                dataKey="ts"
                                type="number"
                                domain={["dataMin", "dataMax"]}
                                tickFormatter={(v: number) => format(new Date(v), "MMM d HH:mm")}
                                stroke="#6b7280"
                                fontSize={11}
                            />
                            <YAxis
                                tickFormatter={(v: number) => `$${v.toLocaleString()}`}
                                stroke="#6b7280"
                                fontSize={11}
                                width={80}
                            />
                            <Tooltip
                                contentStyle={{ backgroundColor: "#1f2937", border: "1px solid #374151", borderRadius: 6 }}
                                labelFormatter={(v) => format(new Date(v as number), "MMM d, HH:mm")}
                                formatter={(v) => [`$${Number(v).toLocaleString(undefined, { minimumFractionDigits: 2 })}`, "Equity"]}
                            />
                            <Line type="monotone" dataKey="equity" stroke="#3b82f6" strokeWidth={2} dot={false} />
                        </LineChart>
                    </ResponsiveContainer>
                </div>
            )}

            {/* Comparison Chart */}
            {comparison.length > 1 && (
                <div className="bg-gray-900 border border-gray-800 rounded-lg p-5 mb-6">
                    <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wider mb-4">
                        Top Traders Comparison
                    </h2>
                    <ComparisonChart participants={comparison} />
                </div>
            )}

            {/* Leaderboard */}
            <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
                <div className="px-5 py-3 border-b border-gray-800">
                    <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wider">
                        Leaderboard
                    </h2>
                </div>

                {leaderboardLoading ? (
                    <div className="text-gray-500 text-center py-8">Loading...</div>
                ) : leaderboard.length === 0 ? (
                    <div className="text-gray-500 text-center py-8">No participants yet</div>
                ) : (
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="text-gray-500 text-xs uppercase border-b border-gray-800">
                                <th className="px-5 py-2 text-left">#</th>
                                <th className="px-5 py-2 text-left">Trader</th>
                                <th className="px-5 py-2 text-right">Return %</th>
                                <th className="px-5 py-2 text-right">Equity</th>
                                <th className="px-5 py-2 text-right">Max DD</th>
                                <th className="px-5 py-2 text-right">Trades</th>
                            </tr>
                        </thead>
                        <tbody>
                            {leaderboard.map((entry) => {
                                const isCurrentUser = entry.user_id === userId;
                                const returnPct = parseFloat(entry.return_pct);
                                return (
                                    <tr
                                        key={entry.user_id}
                                        className={`border-b border-gray-800/50 ${
                                            isCurrentUser ? "bg-blue-900/20" : ""
                                        }`}
                                    >
                                        <td className="px-5 py-3 text-gray-400 font-mono">
                                            {entry.rank}
                                        </td>
                                        <td className="px-5 py-3 text-white">
                                            {entry.display_name}
                                            {isCurrentUser && (
                                                <span className="ml-2 text-xs text-blue-400">(you)</span>
                                            )}
                                        </td>
                                        <td className={`px-5 py-3 text-right font-mono ${
                                            returnPct > 0 ? "text-green-400" : returnPct < 0 ? "text-red-400" : "text-gray-400"
                                        }`}>
                                            {returnPct > 0 ? "+" : ""}{returnPct.toFixed(2)}%
                                        </td>
                                        <td className="px-5 py-3 text-right text-gray-300 font-mono">
                                            ${Number(entry.equity).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                        </td>
                                        <td className="px-5 py-3 text-right text-gray-400 font-mono">
                                            {parseFloat(entry.max_drawdown_pct).toFixed(2)}%
                                        </td>
                                        <td className="px-5 py-3 text-right text-gray-400 font-mono">
                                            {entry.trades_count}
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                )}
            </div>
        </div>
    );
}
