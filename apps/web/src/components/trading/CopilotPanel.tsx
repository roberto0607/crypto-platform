import { useState, useEffect, useRef } from "react";
import { useTradingStore } from "@/stores/tradingStore";
import { useCopilotContext } from "@/hooks/useCopilotContext";
import { postCopilotAnalysis, type CopilotAnalysis } from "@/api/endpoints/signals";

interface CopilotPanelProps {
    pairId: string;
    pairSymbol: string;
    timeframe: string;
}

// ── Number highlighting ──────────────────────────────────

function highlightNumbers(text: string): React.ReactNode {
    const parts = text.split(/(\$[\d,]+(?:\.\d+)?|\d+(?:\.\d+)?%|\d+:\d+(?:\.\d+)?)/g);
    return parts.map((part, i) => {
        if (/^\$/.test(part) || /%$/.test(part) || /^\d+:/.test(part)) {
            return (
                <span key={i} className="text-white font-medium">
                    {part}
                </span>
            );
        }
        return part;
    });
}

// ── Section with fade transition ─────────────────────────

function CopilotSection({
    title,
    content,
    children,
}: {
    title: string;
    content?: string;
    children?: React.ReactNode;
}) {
    const [displayText, setDisplayText] = useState(content ?? "");
    const [fading, setFading] = useState(false);

    useEffect(() => {
        if (content != null && content !== displayText) {
            setFading(true);
            const t = setTimeout(() => {
                setDisplayText(content);
                setFading(false);
            }, 200);
            return () => clearTimeout(t);
        }
    }, [content, displayText]);

    return (
        <div className="px-4 py-3 border-b border-gray-800/50">
            <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">
                {title}
            </div>
            {content != null ? (
                <p
                    className={`text-sm text-gray-300 leading-relaxed transition-opacity duration-200 ${
                        fading ? "opacity-0" : "opacity-100"
                    }`}
                >
                    {highlightNumbers(displayText)}
                </p>
            ) : (
                children
            )}
        </div>
    );
}

// ── Risk Flags Section ───────────────────────────────────

function RiskFlagsSection({
    flags,
}: {
    flags: CopilotAnalysis["riskFlags"];
}) {
    return (
        <CopilotSection title="Risk Flags">
            <div className="space-y-1">
                {flags.map((flag, i) => {
                    const iconEl =
                        flag.severity === "ok" ? (
                            <span className="text-green-400">&#10003;</span>
                        ) : flag.severity === "danger" ? (
                            <span className="text-red-500">&#9679;</span>
                        ) : (
                            <span className="text-yellow-400">&#9888;</span>
                        );
                    return (
                        <div
                            key={i}
                            className="flex items-start gap-2 text-sm text-gray-300"
                        >
                            <span className="flex-shrink-0 mt-0.5">{iconEl}</span>
                            <span>{highlightNumbers(flag.text)}</span>
                        </div>
                    );
                })}
            </div>
        </CopilotSection>
    );
}

// ── Trade Levels ─────────────────────────────────────────

function TradeLevels({ levels }: { levels: NonNullable<CopilotAnalysis["tradeLevels"]> }) {
    return (
        <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
            <div className="text-gray-500">
                Entry:{" "}
                <span className="text-gray-300">
                    ${levels.entry.toLocaleString()}
                </span>
            </div>
            <div className="text-gray-500">
                R/R:{" "}
                <span className="text-gray-300">1:{levels.rrRatio}</span>
            </div>
            {levels.tp1 != null && (
                <div className="text-gray-500">
                    TP1:{" "}
                    <span className="text-green-400">
                        ${levels.tp1.toLocaleString()}
                    </span>{" "}
                    <span className="text-gray-600">
                        ({(levels.tp1Prob * 100).toFixed(0)}%)
                    </span>
                </div>
            )}
            {levels.tp2 != null && (
                <div className="text-gray-500">
                    TP2:{" "}
                    <span className="text-green-400">
                        ${levels.tp2.toLocaleString()}
                    </span>
                </div>
            )}
            {levels.tp3 != null && (
                <div className="text-gray-500">
                    TP3:{" "}
                    <span className="text-green-400">
                        ${levels.tp3.toLocaleString()}
                    </span>
                </div>
            )}
            {levels.sl != null && (
                <div className="text-gray-500">
                    Stop:{" "}
                    <span className="text-red-400">
                        ${levels.sl.toLocaleString()}
                    </span>
                </div>
            )}
        </div>
    );
}

// ── Main Panel ───────────────────────────────────────────

export function CopilotPanel({ pairId, pairSymbol, timeframe }: CopilotPanelProps) {
    const enabled = useTradingStore((s) => s.indicatorConfig.copilot);
    const { context, lastUpdated } = useCopilotContext(
        pairId,
        pairSymbol,
        timeframe,
        enabled,
    );
    const [analysis, setAnalysis] = useState<CopilotAnalysis | null>(null);
    const [collapsed, setCollapsed] = useState(false);
    const prevContextRef = useRef<string>("");

    // Fetch analysis from backend when context updates
    useEffect(() => {
        if (!context || !pairId) return;

        // Debounce — only send if context actually changed
        const key = JSON.stringify({
            p: context.currentPrice,
            s: context.signal.active,
            c: context.signal.confidence,
            d: context.signal.direction,
        });
        if (key === prevContextRef.current) return;
        prevContextRef.current = key;

        let cancelled = false;
        postCopilotAnalysis(pairId, context)
            .then((res) => {
                if (!cancelled) setAnalysis(res.data.analysis);
            })
            .catch(() => {
                // Non-fatal — keep showing last analysis
            });
        return () => {
            cancelled = true;
        };
    }, [context, pairId]);

    if (!enabled || !analysis) return null;

    const convictionColor =
        analysis.conviction >= 70
            ? "#22c55e"
            : analysis.conviction >= 40
                ? "#eab308"
                : "#6b7280";

    const timeSince = Math.max(
        0,
        Math.round((Date.now() - lastUpdated) / 1000),
    );

    return (
        <div className="bg-gray-900/95 border border-gray-700 rounded-lg overflow-hidden">
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-2 border-b border-gray-800">
                <div className="flex items-center gap-2">
                    <span
                        className="w-2 h-2 rounded-full animate-pulse"
                        style={{ backgroundColor: convictionColor }}
                    />
                    <span className="text-xs font-medium text-gray-300 uppercase tracking-wider">
                        Copilot
                    </span>
                    <span className="text-[10px] text-gray-500">
                        Updated {timeSince}s ago
                    </span>
                </div>
                <div className="flex items-center gap-3">
                    {/* Conviction bar */}
                    <div className="flex items-center gap-2">
                        <span className="text-xs text-gray-400">
                            {analysis.convictionLabel.replace(/_/g, " ")}
                        </span>
                        <div className="w-16 h-1.5 bg-gray-800 rounded-full overflow-hidden">
                            <div
                                className="h-full rounded-full transition-all duration-500"
                                style={{
                                    width: `${analysis.conviction}%`,
                                    backgroundColor: convictionColor,
                                }}
                            />
                        </div>
                        <span
                            className="text-xs font-mono"
                            style={{ color: convictionColor }}
                        >
                            {analysis.conviction}
                        </span>
                    </div>
                    {/* Collapse toggle */}
                    <button
                        onClick={() => setCollapsed(!collapsed)}
                        className="text-gray-500 hover:text-gray-300 text-xs"
                    >
                        {collapsed ? "Show" : "Hide"}
                    </button>
                </div>
            </div>

            {/* Change detection banner */}
            {analysis.changesSinceLast.length > 0 && (
                <div className="px-4 py-1.5 bg-yellow-500/10 border-b border-yellow-500/20">
                    <span className="text-xs text-yellow-400">
                        {analysis.changesSinceLast[0]}
                    </span>
                </div>
            )}

            {/* Key datapoints bar */}
            {!collapsed && (
                <div className="flex flex-wrap gap-3 px-4 py-2 border-b border-gray-800/50 bg-gray-900/50">
                    {analysis.keyDatapoints.map((dp, i) => (
                        <span key={i} className="text-xs">
                            <span className="text-gray-500">{dp.label}: </span>
                            <span
                                className={
                                    dp.sentiment === "bullish"
                                        ? "text-green-400"
                                        : dp.sentiment === "bearish"
                                            ? "text-red-400"
                                            : "text-gray-300"
                                }
                            >
                                {dp.value}
                            </span>
                        </span>
                    ))}
                </div>
            )}

            {/* Sections */}
            {!collapsed && (
                <>
                    <CopilotSection
                        title="Market Read"
                        content={analysis.marketRead}
                    />
                    <CopilotSection title="Trade Idea" content={analysis.tradeIdea}>
                        {analysis.tradeLevels && (
                            <TradeLevels levels={analysis.tradeLevels} />
                        )}
                    </CopilotSection>
                    {analysis.tradeLevels && (
                        <div className="px-4 py-2 border-b border-gray-800/50">
                            <TradeLevels levels={analysis.tradeLevels} />
                        </div>
                    )}
                    <RiskFlagsSection flags={analysis.riskFlags} />
                    <CopilotSection
                        title="Your Position"
                        content={analysis.positionAdvice}
                    />
                </>
            )}
        </div>
    );
}
