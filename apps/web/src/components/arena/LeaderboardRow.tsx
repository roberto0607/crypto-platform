/* ─────────────────────────────────────────
   LEADERBOARD ROW — Single row component
───────────────────────────────────────── */

const TIER_COLORS: Record<string, string> = {
    ROOKIE: "#888",
    TRADER: "#888",
    PRO: "#60a5fa",
    SPECIALIST: "#60a5fa",
    EXPERT: "#c084fc",
    ELITE: "#c084fc",
    MASTER: "#FFB800",
    LEGEND: "#FFB800",
};

const RANK_BORDERS: Record<number, string> = {
    1: "#FFB800",
    2: "#aaaaaa",
    3: "#CD7F32",
};

const RANK_BGS: Record<number, string> = {
    1: "rgba(255,180,0,0.08)",
    2: "rgba(180,180,180,0.06)",
    3: "rgba(180,100,0,0.06)",
};

const RANK_AVATAR_BGS: Record<number, string> = {
    1: "rgba(255,180,0,0.15)",
    2: "rgba(180,180,180,0.12)",
    3: "rgba(180,100,0,0.12)",
};

export interface LeaderboardRowEntry {
    rank: number;
    user_id: string;
    display_name: string | null;
    user_tier?: string;
    nuanced_score?: number | string | null;
    return_pct: string;
    win_rate?: number | string | null;
    trades_count: number;
}

interface LeaderboardRowProps {
    entry: LeaderboardRowEntry;
    isCurrentUser: boolean;
    rank: number;
}

export function LeaderboardRow({ entry, isCurrentUser, rank }: LeaderboardRowProps) {
    const isAnonymous = rank > 10 && !isCurrentUser;
    const isTop3 = rank <= 3;

    // Row background
    let rowBg = "transparent";
    if (isCurrentUser) rowBg = "rgba(255,107,0,0.10)";
    else if (isTop3) rowBg = RANK_BGS[rank] ?? "transparent";

    // Left border
    let leftBorder = "2px solid transparent";
    if (isCurrentUser) leftBorder = "2px solid #FF6B00";
    else if (isTop3) leftBorder = `2px solid ${RANK_BORDERS[rank]}`;

    // Name display
    const displayName = isAnonymous ? "Anonymous" : (entry.display_name ?? `Trader #${rank}`);
    const nameLabel = isCurrentUser ? "YOU" : displayName;

    // Score
    const score = entry.nuanced_score != null ? parseFloat(String(entry.nuanced_score)) : 0;

    // P&L
    const pnl = parseFloat(entry.return_pct ?? "0");
    const pnlColor = pnl > 0 ? "#4ade80" : pnl < 0 ? "#f87171" : "#FF6B00";
    const pnlStr = (pnl >= 0 ? "+" : "") + pnl.toFixed(2) + "%";

    // Win rate
    const wr = entry.win_rate != null ? parseFloat(String(entry.win_rate)) : null;

    // Tier
    const tier = entry.user_tier ?? "ROOKIE";
    const tierColor = TIER_COLORS[tier] ?? "#888";

    // Avatar
    const initials = isAnonymous
        ? "?"
        : (entry.display_name ?? "?").slice(0, 2).toUpperCase();

    const avatarBg = isCurrentUser
        ? "rgba(255,107,0,0.15)"
        : isTop3
            ? (RANK_AVATAR_BGS[rank] ?? "rgba(255,107,0,0.06)")
            : "rgba(255,107,0,0.06)";

    const avatarColor = isCurrentUser
        ? "#FF6B00"
        : isTop3
            ? (RANK_BORDERS[rank] ?? "rgba(255,255,255,0.4)")
            : isAnonymous
                ? "rgba(255,255,255,0.2)"
                : "rgba(255,255,255,0.5)";

    return (
        <tr
            className="slb-row"
            style={{
                background: rowBg,
                borderLeft: leftBorder,
            }}
        >
            {/* RANK */}
            <td className="slb-cell slb-rank-cell">
                <span
                    style={{
                        fontFamily: "'Bebas Neue', sans-serif",
                        fontSize: 18,
                        letterSpacing: 1,
                        color: isCurrentUser
                            ? "#FF6B00"
                            : rank === 1 ? "#FFB800"
                            : rank === 2 ? "#aaaaaa"
                            : rank === 3 ? "#CD7F32"
                            : "rgba(255,255,255,0.5)",
                    }}
                >
                    #{rank}
                </span>
            </td>

            {/* TRADER */}
            <td className="slb-cell slb-trader-cell">
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    {/* Avatar */}
                    <div
                        style={{
                            width: 26,
                            height: 26,
                            borderRadius: "50%",
                            background: avatarBg,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            fontSize: 10,
                            fontWeight: 700,
                            letterSpacing: 1,
                            color: avatarColor,
                            flexShrink: 0,
                        }}
                    >
                        {initials}
                    </div>
                    <div style={{ minWidth: 0 }}>
                        <div
                            style={{
                                fontSize: 12,
                                fontWeight: isCurrentUser ? 700 : 400,
                                color: isAnonymous
                                    ? "rgba(255,107,0,0.3)"
                                    : isCurrentUser
                                        ? "#FF6B00"
                                        : "#e0e0e0",
                                fontStyle: isAnonymous ? "italic" : "normal",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                            }}
                        >
                            {nameLabel}
                        </div>
                        {/* Tier badge — only for visible users */}
                        {!isAnonymous && (
                            <span
                                style={{
                                    fontSize: 8,
                                    letterSpacing: 2,
                                    color: tierColor,
                                    opacity: 0.8,
                                }}
                            >
                                {tier}
                            </span>
                        )}
                    </div>
                </div>
            </td>

            {/* SCORE */}
            <td className="slb-cell" style={{ color: "#FF6B00", fontWeight: 700, fontSize: 13 }}>
                {score.toFixed(0)}
            </td>

            {/* P&L % */}
            <td className="slb-cell" style={{ color: pnlColor, fontSize: 11 }}>
                {pnlStr}
            </td>

            {/* WIN RATE */}
            <td className="slb-cell" style={{ color: "rgba(255,255,255,0.5)", fontSize: 11 }}>
                {wr != null ? `${wr.toFixed(0)}%` : "--"}
            </td>

            {/* TRADES */}
            <td className="slb-cell" style={{ color: "rgba(255,255,255,0.5)", fontSize: 11 }}>
                {entry.trades_count}
            </td>
        </tr>
    );
}
