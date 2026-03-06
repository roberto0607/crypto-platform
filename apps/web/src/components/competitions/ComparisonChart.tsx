import {
    ResponsiveContainer,
    LineChart,
    Line,
    XAxis,
    YAxis,
    Tooltip,
    CartesianGrid,
    Legend,
} from "recharts";
import { format } from "date-fns";
import type { ComparisonParticipant } from "@/api/endpoints/competitions";

const COLORS = ["#3b82f6", "#22c55e", "#f59e0b", "#ef4444", "#8b5cf6", "#ec4899", "#14b8a6", "#f97316", "#6366f1", "#84cc16"];

interface Props {
    participants: ComparisonParticipant[];
}

export function ComparisonChart({ participants }: Props) {
    // Merge all participants' snapshots into a unified time series
    // Each row: { ts, p0: equity, p1: equity, ... }
    const allTimestamps = new Set<number>();
    for (const p of participants) {
        for (const s of p.snapshots) {
            allTimestamps.add(s.ts);
        }
    }

    const sortedTs = Array.from(allTimestamps).sort((a, b) => a - b);

    // Build lookup maps for fast interpolation
    const lookups = participants.map((p) => {
        const map = new Map<number, number>();
        for (const s of p.snapshots) {
            map.set(s.ts, parseFloat(s.equity));
        }
        return map;
    });

    // For each timestamp, find the closest known value per participant
    const data = sortedTs.map((ts) => {
        const row: Record<string, number> = { ts };
        for (let i = 0; i < participants.length; i++) {
            const val = lookups[i]?.get(ts);
            if (val !== undefined) {
                row[`p${i}`] = val;
            }
        }
        return row;
    });

    return (
        <ResponsiveContainer width="100%" height={300}>
            <LineChart data={data}>
                <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                <XAxis
                    dataKey="ts"
                    type="number"
                    domain={["dataMin", "dataMax"]}
                    tickFormatter={(v: number) => format(new Date(v), "MMM d")}
                    stroke="#6b7280"
                    fontSize={11}
                />
                <YAxis
                    tickFormatter={(v: number) => `$${(v / 1000).toFixed(0)}k`}
                    stroke="#6b7280"
                    fontSize={11}
                    width={60}
                />
                <Tooltip
                    contentStyle={{
                        backgroundColor: "#1f2937",
                        border: "1px solid #374151",
                        borderRadius: 6,
                    }}
                    labelFormatter={(v) => format(new Date(v as number), "MMM d, HH:mm")}
                />
                <Legend />
                {participants.map((p, i) => (
                    <Line
                        key={i}
                        type="monotone"
                        dataKey={`p${i}`}
                        name={p.label}
                        stroke={COLORS[i % COLORS.length]}
                        strokeWidth={p.label === "You" ? 3 : 1.5}
                        dot={false}
                        connectNulls
                        strokeDasharray={p.label === "You" ? undefined : "4 2"}
                    />
                ))}
            </LineChart>
        </ResponsiveContainer>
    );
}
