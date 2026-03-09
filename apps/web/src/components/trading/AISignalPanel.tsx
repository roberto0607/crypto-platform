import { useEffect, useState, useCallback } from "react";
import { getSignals, type MLSignal, type SignalPerformance } from "@/api/endpoints/signals";
import { useTradingStore } from "@/stores/tradingStore";

interface AISignalPanelProps {
    timeframe: string;
}

export function AISignalPanel({ timeframe }: AISignalPanelProps) {
    const selectedPairId = useTradingStore((s) => s.selectedPairId);
    const aiEnabled = useTradingStore((s) => s.indicatorConfig.aiSignals);

    const [active, setActive] = useState<MLSignal | null>(null);
    const [performance, setPerformance] = useState<SignalPerformance | null>(null);
    const [loading, setLoading] = useState(false);

    const fetchSignals = useCallback(async () => {
        if (!selectedPairId || !aiEnabled) return;
        setLoading(true);
        try {
            const { data } = await getSignals(selectedPairId, { timeframe, limit: 10 });
            setActive(data.active);
            setPerformance(data.performance);
        } catch {
            // Non-fatal
        } finally {
            setLoading(false);
        }
    }, [selectedPairId, timeframe, aiEnabled]);

    useEffect(() => {
        fetchSignals();
    }, [fetchSignals]);

    // Listen for new signals via SSE
    useEffect(() => {
        if (!selectedPairId || !aiEnabled) return;

        const handler = (e: Event) => {
            const detail = (e as CustomEvent).detail;
            if (detail.pairId !== selectedPairId) return;
            // Refetch to get full signal data
            fetchSignals();
        };

        window.addEventListener("sse:signal.new", handler);
        return () => window.removeEventListener("sse:signal.new", handler);
    }, [selectedPairId, aiEnabled, fetchSignals]);

    if (!aiEnabled) return null;

    return (
        <div className="bg-gray-900/50 border border-gray-800 rounded p-3">
            <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                    <span className="text-emerald-400 text-xs font-medium">AI Signals</span>
                    {loading && (
                        <span className="text-gray-600 text-[10px]">Loading...</span>
                    )}
                </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                {/* Active Signal */}
                <div>
                    <div className="text-[10px] text-gray-500 uppercase tracking-widest mb-1.5">
                        Active Signal
                    </div>
                    {active ? (
                        <ActiveSignalCard signal={active} />
                    ) : (
                        <div className="text-gray-600 text-xs py-2">
                            No active signal
                        </div>
                    )}
                </div>

                {/* Performance */}
                <div>
                    <div className="text-[10px] text-gray-500 uppercase tracking-widest mb-1.5">
                        Performance
                    </div>
                    {performance ? (
                        <PerformanceCard perf={performance} />
                    ) : (
                        <div className="text-gray-600 text-xs py-2">
                            No data yet
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

function ActiveSignalCard({ signal }: { signal: MLSignal }) {
    const isBuy = signal.signalType === "BUY";

    return (
        <div className="space-y-1.5">
            <div className="flex items-center gap-2">
                <span
                    className={`text-xs font-bold px-1.5 py-0.5 rounded ${
                        isBuy
                            ? "bg-emerald-500/20 text-emerald-400"
                            : "bg-red-500/20 text-red-400"
                    }`}
                >
                    {signal.signalType}
                </span>
                <span className="text-gray-400 text-xs">
                    Confidence: {signal.confidence}%
                </span>
                <span className="text-gray-600 text-[10px]">
                    {signal.modelVersion}
                </span>
            </div>

            <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs">
                <div className="text-gray-500">
                    Entry: <span className="text-gray-300">${fmtPrice(signal.entryPrice)}</span>
                </div>
                <div className="text-gray-500">
                    SL: <span className="text-red-400">${fmtPrice(signal.stopLossPrice)}</span>
                </div>
                <div className="text-gray-500">
                    TP1: <span className="text-emerald-400">${fmtPrice(signal.tp1Price)}</span>
                    <span className="text-gray-600 ml-1">({signal.tp1Prob}%)</span>
                </div>
                <div className="text-gray-500">
                    TP2: <span className="text-emerald-400">${fmtPrice(signal.tp2Price)}</span>
                    <span className="text-gray-600 ml-1">({signal.tp2Prob}%)</span>
                </div>
                <div className="text-gray-500">
                    TP3: <span className="text-emerald-400">${fmtPrice(signal.tp3Price)}</span>
                    <span className="text-gray-600 ml-1">({signal.tp3Prob}%)</span>
                </div>
                <div className="text-gray-500">
                    Status: <span className="text-gray-300">{signal.outcome}</span>
                </div>
            </div>
        </div>
    );
}

function PerformanceCard({ perf }: { perf: SignalPerformance }) {
    return (
        <div className="grid grid-cols-3 gap-x-4 gap-y-1 text-xs">
            <div>
                <div className="text-gray-500">Signals</div>
                <div className="text-gray-200 font-medium">{perf.totalSignals}</div>
            </div>
            <div>
                <div className="text-gray-500">Win Rate</div>
                <div className="text-gray-200 font-medium">
                    {(perf.winRate * 100).toFixed(0)}%
                </div>
            </div>
            <div>
                <div className="text-gray-500">Avg Conf.</div>
                <div className="text-gray-200 font-medium">{perf.avgConfidence}%</div>
            </div>
            <div>
                <div className="text-gray-500">TP1 Rate</div>
                <div className="text-emerald-400">{(perf.tp1HitRate * 100).toFixed(0)}%</div>
            </div>
            <div>
                <div className="text-gray-500">TP2 Rate</div>
                <div className="text-emerald-400">{(perf.tp2HitRate * 100).toFixed(0)}%</div>
            </div>
            <div>
                <div className="text-gray-500">TP3 Rate</div>
                <div className="text-emerald-400">{(perf.tp3HitRate * 100).toFixed(0)}%</div>
            </div>
        </div>
    );
}

function fmtPrice(price: string): string {
    const n = parseFloat(price);
    if (n >= 1000) return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (n >= 1) return n.toFixed(4);
    return n.toFixed(6);
}
