import { useEffect, useState } from "react";
import { getLiquidationLevels, type LiquidationLevel } from "@/api/endpoints/signals";

interface LiquidationHeatmapProps {
    pairId: string;
    currentPrice: number;
}

export function LiquidationHeatmap({ pairId, currentPrice }: LiquidationHeatmapProps) {
    const [levels, setLevels] = useState<LiquidationLevel[]>([]);

    useEffect(() => {
        if (!pairId) return;

        const fetchLevels = async () => {
            try {
                const { data } = await getLiquidationLevels(pairId);
                setLevels(data.levels);
            } catch {
                // Non-fatal
            }
        };

        fetchLevels();
        const interval = setInterval(fetchLevels, 60_000);
        return () => clearInterval(interval);
    }, [pairId]);

    if (levels.length === 0 || currentPrice <= 0) {
        return (
            <div className="text-[10px] text-gray-600 text-center py-2">
                No liquidation data
            </div>
        );
    }

    // Separate long (below price) and short (above price) liquidations
    const longLiqs = levels.filter((l) => l.side === "long").sort((a, b) => b.price - a.price);
    const shortLiqs = levels.filter((l) => l.side === "short").sort((a, b) => a.price - b.price);

    const maxMagnitude = Math.max(...levels.map((l) => l.magnitude));

    return (
        <div className="space-y-1">
            <div className="text-[10px] text-gray-500 uppercase tracking-widest">
                Liquidation Zones
            </div>

            {/* Short liquidations (above price) */}
            <div className="space-y-0.5">
                {shortLiqs.map((l) => {
                    const intensity = maxMagnitude > 0 ? l.magnitude / maxMagnitude : 0;
                    const pctFromPrice = ((l.price - currentPrice) / currentPrice * 100).toFixed(1);
                    return (
                        <div
                            key={`short-${l.leverage}`}
                            className="flex items-center gap-1.5 text-[10px]"
                            title={`${l.leverage}x shorts liquidated at $${l.price.toLocaleString()} ($${(l.magnitude / 1e6).toFixed(1)}M at risk)`}
                        >
                            <span className="text-gray-500 w-6 text-right">{l.leverage}x</span>
                            <div className="flex-1 h-2 bg-gray-800 rounded-sm overflow-hidden">
                                <div
                                    className="h-full rounded-sm"
                                    style={{
                                        width: `${Math.max(intensity * 100, 5)}%`,
                                        backgroundColor: `rgba(6, 182, 212, ${0.3 + intensity * 0.7})`,
                                    }}
                                />
                            </div>
                            <span className="text-cyan-500 w-10 text-right">+{pctFromPrice}%</span>
                        </div>
                    );
                })}
            </div>

            {/* Current price divider */}
            <div className="flex items-center gap-1.5 py-0.5">
                <span className="text-[10px] text-gray-400">Price</span>
                <div className="flex-1 border-t border-dashed border-gray-600" />
                <span className="text-[10px] text-white font-mono">
                    ${currentPrice.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                </span>
            </div>

            {/* Long liquidations (below price) */}
            <div className="space-y-0.5">
                {longLiqs.map((l) => {
                    const intensity = maxMagnitude > 0 ? l.magnitude / maxMagnitude : 0;
                    const pctFromPrice = ((currentPrice - l.price) / currentPrice * 100).toFixed(1);
                    return (
                        <div
                            key={`long-${l.leverage}`}
                            className="flex items-center gap-1.5 text-[10px]"
                            title={`${l.leverage}x longs liquidated at $${l.price.toLocaleString()} ($${(l.magnitude / 1e6).toFixed(1)}M at risk)`}
                        >
                            <span className="text-gray-500 w-6 text-right">{l.leverage}x</span>
                            <div className="flex-1 h-2 bg-gray-800 rounded-sm overflow-hidden">
                                <div
                                    className="h-full rounded-sm"
                                    style={{
                                        width: `${Math.max(intensity * 100, 5)}%`,
                                        backgroundColor: `rgba(236, 72, 153, ${0.3 + intensity * 0.7})`,
                                    }}
                                />
                            </div>
                            <span className="text-pink-500 w-10 text-right">-{pctFromPrice}%</span>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
