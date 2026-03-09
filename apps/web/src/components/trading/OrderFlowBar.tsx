import { useEffect, useState, useCallback } from "react";
import { getOrderFlow, type OrderFlowFeatures } from "@/api/endpoints/signals";
import { useTradingStore } from "@/stores/tradingStore";

export function OrderFlowBar() {
    const selectedPairId = useTradingStore((s) => s.selectedPairId);
    const enabled = useTradingStore((s) => s.indicatorConfig.orderFlow);

    const [features, setFeatures] = useState<OrderFlowFeatures | null>(null);

    const fetch = useCallback(async () => {
        if (!selectedPairId || !enabled) return;
        try {
            const res = await getOrderFlow(selectedPairId);
            setFeatures(res.data.features);
        } catch {
            // Non-fatal
        }
    }, [selectedPairId, enabled]);

    useEffect(() => {
        fetch();
        if (!enabled) return;
        const interval = setInterval(fetch, 5_000);
        return () => clearInterval(interval);
    }, [fetch, enabled]);

    if (!enabled || !features) return null;

    const imb = features.bidAskImbalance;
    const buyPct = Math.round((imb + 1) * 50); // map [-1,1] to [0,100]
    const sellPct = 100 - buyPct;
    const isBuyDominant = imb > 0;

    return (
        <div className="bg-gray-900/50 border border-gray-800 rounded px-3 py-2">
            <div className="flex items-center justify-between mb-1.5">
                <span className="text-[10px] text-gray-500 uppercase tracking-widest">
                    Order Flow
                </span>
                <span className="text-[10px] text-gray-600">
                    {features.ts ? `${Math.round((Date.now() - features.ts) / 1000)}s ago` : ""}
                </span>
            </div>

            {/* Imbalance bar */}
            <div className="flex items-center gap-2 mb-1.5">
                <span className="text-[10px] text-red-400 w-8 text-right">{sellPct}%</span>
                <div className="flex-1 h-2.5 bg-gray-800 rounded-full overflow-hidden flex">
                    <div
                        className="bg-red-500/70 transition-all duration-500"
                        style={{ width: `${sellPct}%` }}
                    />
                    <div
                        className="bg-emerald-500/70 transition-all duration-500"
                        style={{ width: `${buyPct}%` }}
                    />
                </div>
                <span className="text-[10px] text-emerald-400 w-8">{buyPct}%</span>
            </div>

            {/* Stats row */}
            <div className="flex items-center gap-3 text-[10px]">
                <span className="text-gray-500">
                    Imbalance:{" "}
                    <span className={isBuyDominant ? "text-emerald-400" : "text-red-400"}>
                        {imb > 0 ? "+" : ""}{imb.toFixed(3)}
                    </span>
                </span>
                <span className="text-gray-500">
                    Spread:{" "}
                    <span className="text-gray-300">{features.spreadBps} bps</span>
                </span>
                <span className="text-gray-500">
                    Depth:{" "}
                    <span className="text-gray-300">
                        ${fmtUsd(features.bidDepthUsd)} / ${fmtUsd(features.askDepthUsd)}
                    </span>
                </span>

                {/* Whale alerts */}
                {features.largeOrderBid && (
                    <span className="text-emerald-400 font-medium">
                        Large Bid {features.bidWallPrice ? `@ $${fmtPrice(features.bidWallPrice)}` : ""}
                    </span>
                )}
                {features.largeOrderAsk && (
                    <span className="text-red-400 font-medium">
                        Large Ask {features.askWallPrice ? `@ $${fmtPrice(features.askWallPrice)}` : ""}
                    </span>
                )}
            </div>
        </div>
    );
}

function fmtUsd(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
    return n.toFixed(0);
}

function fmtPrice(n: number): string {
    if (n >= 1000) return n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
    if (n >= 1) return n.toFixed(2);
    return n.toFixed(4);
}
