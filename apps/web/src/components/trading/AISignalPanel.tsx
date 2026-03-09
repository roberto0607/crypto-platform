import { useEffect, useState, useCallback, useMemo } from "react";
import {
    getSignals,
    getEquityCurve,
    type MLSignal,
    type SignalPerformance,
    type SignalExplanation,
    type EquityCurvePoint,
    type ForecastHorizon,
} from "@/api/endpoints/signals";
import { useTradingStore } from "@/stores/tradingStore";

interface AISignalPanelProps {
    timeframe: string;
}

export function AISignalPanel({ timeframe }: AISignalPanelProps) {
    const selectedPairId = useTradingStore((s) => s.selectedPairId);
    const aiEnabled = useTradingStore((s) => s.indicatorConfig.aiSignals);

    const [active, setActive] = useState<MLSignal | null>(null);
    const [performance, setPerformance] = useState<SignalPerformance | null>(null);
    const [equityCurve, setEquityCurve] = useState<{
        curve: EquityCurvePoint[];
        totalReturn: number;
        maxDrawdown: number;
        sharpe: number;
    } | null>(null);
    const [loading, setLoading] = useState(false);

    const fetchSignals = useCallback(async () => {
        if (!selectedPairId || !aiEnabled) return;
        setLoading(true);
        try {
            const [signalRes, curveRes] = await Promise.all([
                getSignals(selectedPairId, { timeframe, limit: 10 }),
                getEquityCurve(),
            ]);
            setActive(signalRes.data.active);
            setPerformance(signalRes.data.performance);
            setEquityCurve({
                curve: curveRes.data.curve,
                totalReturn: curveRes.data.totalReturn,
                maxDrawdown: curveRes.data.maxDrawdown,
                sharpe: curveRes.data.sharpe,
            });
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
                {/* Left: Active Signal + Model Votes */}
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

                {/* Right: Explanation */}
                <div>
                    <div className="text-[10px] text-gray-500 uppercase tracking-widest mb-1.5">
                        Why This Signal
                    </div>
                    {active?.explanation ? (
                        <ExplanationCard explanation={active.explanation} />
                    ) : (
                        <div className="text-gray-600 text-xs py-2">
                            {active ? "No explanation available" : "Generate a signal to see analysis"}
                        </div>
                    )}
                </div>
            </div>

            {/* TFT Forecast Horizons */}
            {active?.forecast && (
                <ForecastRow forecast={active.forecast} />
            )}

            {/* Bottom row: Performance + Equity Curve */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 mt-3 pt-3 border-t border-gray-800/50">
                <div>
                    <div className="text-[10px] text-gray-500 uppercase tracking-widest mb-1.5">
                        Performance
                    </div>
                    {performance ? (
                        <PerformanceCard perf={performance} />
                    ) : (
                        <div className="text-gray-600 text-xs py-2">No data yet</div>
                    )}
                </div>
                <div>
                    <div className="text-[10px] text-gray-500 uppercase tracking-widest mb-1.5">
                        Equity Curve
                    </div>
                    {equityCurve ? (
                        <EquityCurveCard data={equityCurve} />
                    ) : (
                        <div className="text-gray-600 text-xs py-2">No closed signals yet</div>
                    )}
                </div>
            </div>
        </div>
    );
}

// ---------------------------------------------------------------------------
// Regime display helpers
// ---------------------------------------------------------------------------

const REGIME_COLORS: Record<string, string> = {
    TRENDING_UP: "bg-emerald-500/20 text-emerald-400",
    TRENDING_DOWN: "bg-red-500/20 text-red-400",
    RANGING: "bg-blue-500/20 text-blue-400",
    VOLATILE: "bg-orange-500/20 text-orange-400",
    TRANSITIONING: "bg-gray-600/30 text-gray-400",
};

const STRATEGY_LABELS: Record<string, string> = {
    momentum: "Momentum",
    mean_reversion: "Mean Reversion",
    volatility: "Volatility",
    abstain: "Abstain",
};

// ---------------------------------------------------------------------------
// Active Signal Card
// ---------------------------------------------------------------------------

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

            {/* Regime badge + strategy */}
            {signal.regime && (
                <div className="flex items-center gap-2">
                    <span
                        className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${
                            REGIME_COLORS[signal.regime] ?? "bg-gray-700/50 text-gray-400"
                        }`}
                    >
                        {signal.regime.replace("_", " ")}
                    </span>
                    {signal.strategy && (
                        <span className="text-[10px] text-gray-500">
                            Strategy: {STRATEGY_LABELS[signal.strategy] ?? signal.strategy}
                        </span>
                    )}
                    {signal.regimeConfidence != null && (
                        <div className="flex items-center gap-1 ml-auto">
                            <div className="w-16 h-1 bg-gray-800 rounded-full overflow-hidden">
                                <div
                                    className="h-full bg-cyan-500 rounded-full"
                                    style={{ width: `${Math.round(signal.regimeConfidence * 100)}%` }}
                                />
                            </div>
                            <span className="text-[10px] text-gray-600">
                                {Math.round(signal.regimeConfidence * 100)}%
                            </span>
                        </div>
                    )}
                </div>
            )}

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

            {/* Model Votes */}
            {signal.explanation?.model_votes && (
                <div className="flex items-center gap-1.5 mt-1">
                    <span className="text-[10px] text-gray-500">Models:</span>
                    {Object.entries(signal.explanation.model_votes).map(([model, vote]) => (
                        <span
                            key={model}
                            className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
                                vote === "BUY"
                                    ? "bg-emerald-500/20 text-emerald-400"
                                    : vote === "SELL"
                                      ? "bg-red-500/20 text-red-400"
                                      : "bg-gray-700/50 text-gray-400"
                            }`}
                            title={`${model}: ${vote}`}
                        >
                            {model.slice(0, 4).toUpperCase()}:{vote.slice(0, 1)}
                        </span>
                    ))}
                </div>
            )}
        </div>
    );
}

// ---------------------------------------------------------------------------
// Explanation Card
// ---------------------------------------------------------------------------

const ICON_COLORS: Record<string, string> = {
    momentum: "text-blue-400",
    trend: "text-purple-400",
    regime: "text-cyan-400",
    agreement: "text-emerald-400",
    volume: "text-yellow-400",
    pattern: "text-orange-400",
    volatility: "text-amber-400",
    calendar: "text-gray-400",
    other: "text-gray-400",
};

function ExplanationCard({ explanation }: { explanation: SignalExplanation }) {
    return (
        <div className="space-y-1.5">
            {/* Summary */}
            <div className="text-xs text-gray-200 italic">
                &quot;{explanation.summary}&quot;
            </div>

            {/* Reasons */}
            <div className="space-y-0.5">
                {explanation.reasons.map((r, i) => (
                    <div key={i} className="flex items-start gap-1.5 text-xs">
                        <span className={`mt-0.5 ${ICON_COLORS[r.icon] ?? "text-gray-400"}`}>
                            {r.weight === "high" ? "\u25C9" : "\u25CB"}
                        </span>
                        <span className="text-gray-300">{r.text}</span>
                    </div>
                ))}
            </div>

            {/* Caution */}
            {explanation.caution && (
                <div className="flex items-start gap-1.5 text-xs mt-1">
                    <span className="text-amber-400 mt-0.5">{"\u26A0"}</span>
                    <span className="text-amber-300">{explanation.caution}</span>
                </div>
            )}

            {/* Attention highlight */}
            {explanation.attention_highlight && (
                <div className="text-[10px] text-gray-500 mt-1">
                    {explanation.attention_highlight}
                </div>
            )}
        </div>
    );
}

// ---------------------------------------------------------------------------
// Forecast Row (TFT quantile horizons)
// ---------------------------------------------------------------------------

const HORIZON_ORDER = ["t+1", "t+3", "t+6", "t+12"];

function ForecastRow({ forecast }: { forecast: Record<string, ForecastHorizon> }) {
    return (
        <div className="mt-3 pt-3 border-t border-gray-800/50">
            <div className="text-[10px] text-gray-500 uppercase tracking-widest mb-1.5">
                Price Forecast
            </div>
            <div className="grid grid-cols-4 gap-2 text-xs">
                {HORIZON_ORDER.map((h) => {
                    const hz = forecast[h];
                    if (!hz) return null;
                    const isUp = hz.p50 > 0;
                    return (
                        <div key={h} className="text-center">
                            <div className="text-gray-500 text-[10px] mb-0.5">{h}</div>
                            <div className={isUp ? "text-emerald-400 font-medium" : "text-red-400 font-medium"}>
                                {isUp ? "+" : ""}{(hz.p50 * 100).toFixed(2)}%
                            </div>
                            <div className="text-gray-600 text-[10px]">
                                {(hz.p10 * 100).toFixed(1)}% — {(hz.p90 * 100).toFixed(1)}%
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

// ---------------------------------------------------------------------------
// Performance Card
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Equity Curve Card (SVG sparkline)
// ---------------------------------------------------------------------------

function EquityCurveCard({ data }: {
    data: {
        curve: EquityCurvePoint[];
        totalReturn: number;
        maxDrawdown: number;
        sharpe: number;
    };
}) {
    const { curve, totalReturn, maxDrawdown, sharpe } = data;

    const svgPath = useMemo(() => {
        if (curve.length < 2) return null;

        const values = curve.map((p) => p.cumPnlPct);
        const min = Math.min(0, ...values);
        const max = Math.max(0, ...values);
        const range = max - min || 1;

        const w = 200;
        const h = 40;
        const pad = 2;

        const points = values.map((v, i) => {
            const x = pad + (i / (values.length - 1)) * (w - 2 * pad);
            const y = h - pad - ((v - min) / range) * (h - 2 * pad);
            return `${x},${y}`;
        });

        // Zero line Y
        const zeroY = h - pad - ((0 - min) / range) * (h - 2 * pad);

        return { path: `M${points.join("L")}`, w, h, zeroY };
    }, [curve]);

    const isPositive = totalReturn >= 0;

    if (curve.length === 0) {
        return <div className="text-gray-600 text-xs py-2">No closed signals yet</div>;
    }

    return (
        <div className="space-y-1.5">
            {/* Sparkline */}
            {svgPath && (
                <svg
                    viewBox={`0 0 ${svgPath.w} ${svgPath.h}`}
                    className="w-full h-10"
                    preserveAspectRatio="none"
                >
                    {/* Zero line */}
                    <line
                        x1="0" y1={svgPath.zeroY}
                        x2={svgPath.w} y2={svgPath.zeroY}
                        stroke="#374151" strokeWidth="0.5" strokeDasharray="3,3"
                    />
                    {/* Curve */}
                    <path
                        d={svgPath.path}
                        fill="none"
                        stroke={isPositive ? "#34d399" : "#f87171"}
                        strokeWidth="1.5"
                    />
                </svg>
            )}

            {/* Stats row */}
            <div className="grid grid-cols-3 gap-x-3 text-xs">
                <div>
                    <div className="text-gray-500">Return</div>
                    <div className={isPositive ? "text-emerald-400 font-medium" : "text-red-400 font-medium"}>
                        {isPositive ? "+" : ""}{totalReturn.toFixed(1)}%
                    </div>
                </div>
                <div>
                    <div className="text-gray-500">Max DD</div>
                    <div className="text-red-400">-{maxDrawdown.toFixed(1)}%</div>
                </div>
                <div>
                    <div className="text-gray-500">Sharpe</div>
                    <div className="text-gray-200">{sharpe.toFixed(2)}</div>
                </div>
            </div>
        </div>
    );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtPrice(price: string): string {
    const n = parseFloat(price);
    if (n >= 1000) return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (n >= 1) return n.toFixed(4);
    return n.toFixed(6);
}
