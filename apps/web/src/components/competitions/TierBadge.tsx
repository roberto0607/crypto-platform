const TIER_STYLES: Record<string, string> = {
    ROOKIE: "bg-gray-800 text-gray-400",
    TRADER: "bg-green-900/50 text-green-400",
    SPECIALIST: "bg-blue-900/50 text-blue-400",
    EXPERT: "bg-purple-900/50 text-purple-400",
    MASTER: "bg-amber-900/50 text-amber-400",
    LEGEND: "bg-red-900/50 text-red-400",
};

const SIZE_CLASSES = {
    sm: "px-1.5 py-0.5 text-[10px]",
    md: "px-2 py-0.5 text-xs",
};

interface TierBadgeProps {
    tier: string;
    size?: "sm" | "md";
}

export function TierBadge({ tier, size = "md" }: TierBadgeProps) {
    const style = TIER_STYLES[tier] ?? TIER_STYLES.ROOKIE;
    return (
        <span className={`inline-block rounded font-medium ${style} ${SIZE_CLASSES[size]}`}>
            {tier}
        </span>
    );
}
