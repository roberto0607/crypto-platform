import { useEffect, useState, useCallback } from "react";
import { getDerivatives, type DerivativesSnapshot } from "@/api/endpoints/signals";
import { useTradingStore } from "@/stores/tradingStore";

export function DerivativesPanel() {
    const selectedPairId = useTradingStore((s) => s.selectedPairId);
    const enabled = useTradingStore((s) => s.indicatorConfig.derivatives);

    const [data, setData] = useState<DerivativesSnapshot | null>(null);

    const fetchData = useCallback(async () => {
        if (!selectedPairId || !enabled) return;
        try {
            const res = await getDerivatives(selectedPairId);
            setData(res.data.derivatives);
        } catch {
            // Non-fatal
        }
    }, [selectedPairId, enabled]);

    useEffect(() => {
        fetchData();
        if (!enabled) return;
        const interval = setInterval(fetchData, 10_000);
        return () => clearInterval(interval);
    }, [fetchData, enabled]);

    if (!enabled || !data) return null;

    const fundingPct = data.fundingRate * 100;
    const fundingAnn = data.fundingRate * 3 * 365 * 100;
    const isFundingPositive = data.fundingRate > 0;

    const longPct = Math.round(data.globalLongPct * 100);
    const shortPct = 100 - longPct;

    const topLongPct = Math.round(data.topLongPct * 100);
    const topShortPct = 100 - topLongPct;

    const hasLiq = data.liqIntensity > 0.001;
    const liqSide = data.liqPressure < 0 ? "Longs" : "Shorts";

    return (
        <div className="bg-gray-900/50 border border-gray-800 rounded px-3 py-2">
            <div className="flex items-center justify-between mb-1.5">
                <span className="text-[10px] text-gray-500 uppercase tracking-widest">
                    Derivatives
                </span>
                <span className="text-[10px] text-gray-600">
                    {data.ts ? `${Math.round((Date.now() - data.ts) / 1000)}s ago` : ""}
                </span>
            </div>

            {/* Funding Rate + OI Row */}
            <div className="flex items-center gap-4 mb-1.5 flex-wrap">
                <span className="text-[10px] text-gray-500">
                    Funding:{" "}
                    <span className={isFundingPositive ? "text-red-400" : "text-emerald-400"}>
                        {isFundingPositive ? "+" : ""}{fundingPct.toFixed(4)}%
                    </span>
                    <span className="text-gray-600 ml-1">
                        ({fundingAnn > 0 ? "+" : ""}{fundingAnn.toFixed(1)}% ann)
                    </span>
                </span>

                <span className="text-[10px] text-gray-500">
                    OI:{" "}
                    <span className="text-gray-300">${fmtUsd(data.openInterestUsd)}</span>
                    {data.oiChangePct !== 0 && (
                        <span className={data.oiChangePct > 0 ? "text-emerald-400 ml-1" : "text-red-400 ml-1"}>
                            {data.oiChangePct > 0 ? "+" : ""}{data.oiChangePct.toFixed(2)}%
                        </span>
                    )}
                </span>

                <span className="text-[10px] text-gray-500">
                    Mark:{" "}
                    <span className="text-gray-300">${fmtPrice(data.markPrice)}</span>
                </span>
            </div>

            {/* L/S Ratio Bars */}
            <div className="flex items-center gap-2 mb-1">
                <span className="text-[10px] text-red-400 w-8 text-right">{shortPct}%</span>
                <div className="flex-1 h-2 bg-gray-800 rounded-full overflow-hidden flex">
                    <div
                        className="bg-red-500/70 transition-all duration-500"
                        style={{ width: `${shortPct}%` }}
                    />
                    <div
                        className="bg-emerald-500/70 transition-all duration-500"
                        style={{ width: `${longPct}%` }}
                    />
                </div>
                <span className="text-[10px] text-emerald-400 w-8">{longPct}%</span>
                <span className="text-[10px] text-gray-600 w-12">Global</span>
            </div>

            <div className="flex items-center gap-2 mb-1.5">
                <span className="text-[10px] text-red-400 w-8 text-right">{topShortPct}%</span>
                <div className="flex-1 h-2 bg-gray-800 rounded-full overflow-hidden flex">
                    <div
                        className="bg-red-500/50 transition-all duration-500"
                        style={{ width: `${topShortPct}%` }}
                    />
                    <div
                        className="bg-emerald-500/50 transition-all duration-500"
                        style={{ width: `${topLongPct}%` }}
                    />
                </div>
                <span className="text-[10px] text-emerald-400 w-8">{topLongPct}%</span>
                <span className="text-[10px] text-gray-600 w-12">Whales</span>
            </div>

            {/* Stats row */}
            <div className="flex items-center gap-3 text-[10px] flex-wrap">
                <span className="text-gray-500">
                    L/S:{" "}
                    <span className={data.globalLsRatio > 1 ? "text-emerald-400" : "text-red-400"}>
                        {data.globalLsRatio.toFixed(2)}
                    </span>
                </span>
                <span className="text-gray-500">
                    Top L/S:{" "}
                    <span className={data.topLsRatio > 1 ? "text-emerald-400" : "text-red-400"}>
                        {data.topLsRatio.toFixed(2)}
                    </span>
                </span>

                {hasLiq && (
                    <span className={data.liqPressure < 0 ? "text-red-400 font-medium" : "text-emerald-400 font-medium"}>
                        {liqSide} Liquidated ({(data.liqIntensity * 100).toFixed(1)}%)
                    </span>
                )}

                {Math.abs(data.fundingRate) > 0.0005 && (
                    <span className="text-yellow-400 font-medium">
                        Extreme Funding
                    </span>
                )}

                {data.globalLsRatio > 2 && (
                    <span className="text-yellow-400 font-medium">
                        Crowded Long
                    </span>
                )}
                {data.globalLsRatio < 0.5 && (
                    <span className="text-yellow-400 font-medium">
                        Crowded Short
                    </span>
                )}
            </div>
        </div>
    );
}

function fmtUsd(n: number): string {
    if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
    return n.toFixed(0);
}

function fmtPrice(n: number): string {
    if (n >= 1000) return n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
    if (n >= 1) return n.toFixed(2);
    return n.toFixed(4);
}
