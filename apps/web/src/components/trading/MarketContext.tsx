import { useEffect, useState } from "react";
import { getDerivatives, type DerivativesSnapshot } from "@/api/endpoints/signals";

interface MarketContextProps {
    pairId: string;
}

export function MarketContext({ pairId }: MarketContextProps) {
    const [data, setData] = useState<DerivativesSnapshot | null>(null);

    useEffect(() => {
        if (!pairId) return;

        const fetchData = async () => {
            try {
                const res = await getDerivatives(pairId);
                setData(res.data.derivatives);
            } catch {
                // Non-fatal
            }
        };

        fetchData();
        const interval = setInterval(fetchData, 30_000);
        return () => clearInterval(interval);
    }, [pairId]);

    if (!data) return null;

    const fundingRate = data.fundingRate ?? 0;
    const fundingColor = fundingRate > 0 ? "text-red-400" : fundingRate < 0 ? "text-green-400" : "text-gray-400";
    const fundingSign = fundingRate > 0 ? "+" : "";

    const oiChange = data.oiChangePct ?? 0;
    const oiColor = oiChange > 0 ? "text-green-400" : oiChange < 0 ? "text-red-400" : "text-gray-400";
    const oiSign = oiChange > 0 ? "+" : "";

    return (
        <div className="flex items-center gap-3 px-2 py-1.5 bg-gray-900/50 rounded border border-gray-800 text-[10px]">
            {/* Funding Rate */}
            <div className="flex items-center gap-1">
                <span className="text-gray-500">Fund</span>
                <span className={fundingColor}>
                    {fundingSign}{(fundingRate * 100).toFixed(4)}%
                </span>
            </div>

            <div className="w-px h-3 bg-gray-700" />

            {/* OI Change */}
            <div className="flex items-center gap-1">
                <span className="text-gray-500">OI</span>
                <span className={oiColor}>
                    {oiSign}{oiChange.toFixed(1)}%
                </span>
            </div>

            <div className="w-px h-3 bg-gray-700" />

            {/* L/S Ratio */}
            <div className="flex items-center gap-1">
                <span className="text-gray-500">L/S</span>
                <span className="text-gray-300">
                    {data.globalLsRatio?.toFixed(2) ?? "—"}
                </span>
            </div>
        </div>
    );
}
