interface OpponentActivityFeedProps {
    // Future: pass in activity entries if real-time data becomes available
    activities?: { ts: string; action: string }[];
}

export function OpponentActivityFeed({ activities }: OpponentActivityFeedProps) {
    if (!activities || activities.length === 0) {
        return (
            <div className="lmv-opp-feed">
                <div className="lmv-feed-label">OPPONENT ACTIVITY</div>
                <div className="lmv-feed-empty">
                    Opponent activity is private until match ends.
                </div>
            </div>
        );
    }

    return (
        <div className="lmv-opp-feed">
            <div className="lmv-feed-label">OPPONENT ACTIVITY</div>
            <div className="lmv-feed-list">
                {activities.slice(0, 20).map((a, i) => (
                    <div key={i} className="lmv-feed-entry">
                        <span className="lmv-feed-ts">
                            {new Date(a.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                        </span>
                        <span className="lmv-feed-action">{a.action}</span>
                    </div>
                ))}
            </div>
        </div>
    );
}
