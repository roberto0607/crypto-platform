import type { TradeSetup } from "@/lib/confluenceEngine";

interface TradeSetupCardProps {
    setup: TradeSetup | null;
}

function formatPrice(p: number): string {
    if (p >= 1000) return p.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (p >= 1) return p.toFixed(4);
    return p.toFixed(6);
}

function pctFromEntry(price: number, entryMid: number): string {
    const pct = ((price - entryMid) / entryMid) * 100;
    const sign = pct >= 0 ? "+" : "";
    return `${sign}${pct.toFixed(2)}%`;
}

export function TradeSetupCard({ setup }: TradeSetupCardProps) {
    if (!setup) {
        return (
            <div className="space-y-2">
                <div className="text-[10px] text-gray-600 uppercase tracking-widest">
                    Trade Setup
                </div>
                <div className="flex items-center justify-center py-6">
                    <div className="text-center space-y-1">
                        <div className="text-gray-500 text-sm font-medium">No Clear Setup</div>
                        <div className="text-gray-600 text-[10px]">
                            Wait for confluence — 3+ signals must agree
                        </div>
                    </div>
                </div>
            </div>
        );
    }

    const entryMid = (setup.entryZone.low + setup.entryZone.high) / 2;
    const isLong = setup.direction === "long";
    const dirColor = isLong ? "text-green-400" : "text-red-400";
    const dirBg = isLong ? "bg-green-500/20 border-green-500/30" : "bg-red-500/20 border-red-500/30";

    return (
        <div className="space-y-2">
            <div className="text-[10px] text-gray-600 uppercase tracking-widest">
                Trade Setup
            </div>

            {/* Direction badge + confidence */}
            <div className="flex items-center justify-between">
                <span className={`px-2 py-0.5 rounded border text-xs font-bold ${dirBg} ${dirColor}`}>
                    {setup.direction.toUpperCase()}
                </span>
                <div className="flex items-center gap-1.5">
                    <div className="w-16 h-1.5 bg-gray-800 rounded-full overflow-hidden">
                        <div
                            className={`h-full rounded-full ${isLong ? "bg-green-500" : "bg-red-500"}`}
                            style={{ width: `${setup.confidence}%` }}
                        />
                    </div>
                    <span className="text-[10px] text-gray-400">{setup.confidence}%</span>
                </div>
            </div>

            {/* Entry / SL / TP levels */}
            <div className="space-y-1 text-[11px]">
                <div className="flex justify-between">
                    <span className="text-gray-500">Entry</span>
                    <span className="text-gray-300">
                        {formatPrice(setup.entryZone.low)} — {formatPrice(setup.entryZone.high)}
                    </span>
                </div>
                <div className="flex justify-between">
                    <span className="text-red-400">Stop Loss</span>
                    <span className="text-red-400">
                        {formatPrice(setup.stopLoss)}{" "}
                        <span className="text-red-400/60 text-[10px]">
                            {pctFromEntry(setup.stopLoss, entryMid)}
                        </span>
                    </span>
                </div>
                <div className="flex justify-between">
                    <span className="text-blue-400">TP1</span>
                    <span className="text-blue-400">
                        {formatPrice(setup.tp1)}{" "}
                        <span className="text-blue-400/60 text-[10px]">
                            {pctFromEntry(setup.tp1, entryMid)}
                        </span>
                    </span>
                </div>
                {setup.tp2 != null && (
                    <div className="flex justify-between">
                        <span className="text-blue-400/70">TP2</span>
                        <span className="text-blue-400/70">
                            {formatPrice(setup.tp2)}{" "}
                            <span className="text-blue-400/40 text-[10px]">
                                {pctFromEntry(setup.tp2, entryMid)}
                            </span>
                        </span>
                    </div>
                )}
                {setup.tp3 != null && (
                    <div className="flex justify-between">
                        <span className="text-blue-400/50">TP3</span>
                        <span className="text-blue-400/50">
                            {formatPrice(setup.tp3)}{" "}
                            <span className="text-blue-400/30 text-[10px]">
                                {pctFromEntry(setup.tp3, entryMid)}
                            </span>
                        </span>
                    </div>
                )}
            </div>

            {/* R:R */}
            <div className="flex items-center justify-between bg-gray-800/50 rounded px-2 py-1">
                <span className="text-[10px] text-gray-500">Risk / Reward</span>
                <span className="text-xs font-bold text-white">1 : {setup.rrRatio}</span>
            </div>

            {/* Agreeing signals */}
            <div className="space-y-0.5">
                {setup.agreeingSignals.map((s, i) => (
                    <div key={i} className="flex items-center gap-1.5 text-[10px]">
                        <span className="text-green-500">&#10003;</span>
                        <span className="text-gray-400">{s.name}</span>
                        <span className="text-gray-600 ml-auto">{s.strength}</span>
                    </div>
                ))}
            </div>

            {/* Conflicting signals */}
            {setup.conflictingSignals.length > 0 && (
                <div className="space-y-0.5">
                    {setup.conflictingSignals.map((s, i) => (
                        <div key={i} className="flex items-center gap-1.5 text-[10px]">
                            <span className="text-red-500/50">&#10007;</span>
                            <span className="text-gray-600">{s.name}</span>
                            <span className="text-gray-700 ml-auto">{s.strength}</span>
                        </div>
                    ))}
                </div>
            )}

            {/* Reasoning */}
            <div className="text-[10px] text-gray-500 italic border-t border-gray-800 pt-1">
                {setup.reasoning}
            </div>
        </div>
    );
}
