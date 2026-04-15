import { useMemo } from "react";
import type { CyclePosition } from "@/api/endpoints/marketData";

interface CycleWheelProps {
    cyclePosition: CyclePosition;
    size?: number;
}

// 4 phases, each a 90° arc starting at 12 o'clock, going clockwise.
// Arc order matches the life of a cycle: accumulation → early bull →
// parabolic bull → distribution.
const PHASES = [
    { name: "ACCUMULATION", color: "#6B7280", startDeg: 0,   endDeg: 90 },
    { name: "EARLY BULL",   color: "#10B981", startDeg: 90,  endDeg: 180 },
    { name: "PARABOLIC",    color: "#F59E0B", startDeg: 180, endDeg: 270 },
    { name: "DISTRIBUTION", color: "#EF4444", startDeg: 270, endDeg: 360 },
];

const TRACK_WIDTH = 22;

/** Convert a 12-o'clock-anchored clockwise angle (deg) to an (x, y) point
 *  on a circle of given radius centered at (cx, cy). */
function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
    const rad = ((deg - 90) * Math.PI) / 180; // -90 to put 0° at top
    return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
}

function arcPath(cx: number, cy: number, r: number, startDeg: number, endDeg: number): string {
    const [x1, y1] = polar(cx, cy, r, startDeg);
    const [x2, y2] = polar(cx, cy, r, endDeg);
    const large = endDeg - startDeg > 180 ? 1 : 0;
    return `M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2}`;
}

export function CycleWheel({ cyclePosition, size = 320 }: CycleWheelProps) {
    const cx = size / 2;
    const cy = size / 2;
    const r = size / 2 - TRACK_WIDTH / 2 - 4;

    const dotDeg = (cyclePosition.cyclePercent / 100) * 360;
    const [dotX, dotY] = polar(cx, cy, r, dotDeg);

    const labelRadius = r - TRACK_WIDTH - 6;

    const labels = useMemo(() => (
        PHASES.map((p) => {
            const midDeg = (p.startDeg + p.endDeg) / 2;
            const [lx, ly] = polar(cx, cy, labelRadius, midDeg);
            return { ...p, lx, ly };
        })
    ), [cx, cy, labelRadius]);

    return (
        <svg viewBox={`0 0 ${size} ${size}`} width="100%" height="100%" style={{ maxWidth: size }}>
            <defs>
                <filter id="cw-glow" x="-50%" y="-50%" width="200%" height="200%">
                    <feGaussianBlur stdDeviation="3" result="blur" />
                    <feMerge>
                        <feMergeNode in="blur" />
                        <feMergeNode in="SourceGraphic" />
                    </feMerge>
                </filter>
                <style>{`
                    @keyframes cw-pulse {
                        0%, 100% { r: 7; opacity: 1; }
                        50% { r: 10; opacity: 0.7; }
                    }
                    .cw-dot { animation: cw-pulse 2s ease-in-out infinite; }
                `}</style>
            </defs>

            {/* Track arcs */}
            {PHASES.map((p) => (
                <path
                    key={p.name}
                    d={arcPath(cx, cy, r, p.startDeg, p.endDeg)}
                    stroke={p.color}
                    strokeWidth={TRACK_WIDTH}
                    fill="none"
                    strokeLinecap="butt"
                    opacity={0.75}
                />
            ))}

            {/* Phase labels (outside the track) */}
            {labels.map((p) => (
                <text
                    key={`lbl-${p.name}`}
                    x={p.lx}
                    y={p.ly}
                    fill={p.color}
                    fontSize="9"
                    fontFamily="'Space Mono', monospace"
                    textAnchor="middle"
                    dominantBaseline="middle"
                    letterSpacing="1"
                >
                    {p.name}
                </text>
            ))}

            {/* Current-position dot */}
            <circle cx={dotX} cy={dotY} r={10} fill="#F59E0B" opacity={0.35} />
            <circle
                cx={dotX}
                cy={dotY}
                r={7}
                fill="#FDE68A"
                stroke="#F59E0B"
                strokeWidth={2}
                filter="url(#cw-glow)"
                className="cw-dot"
            />

            {/* Center text */}
            <text
                x={cx} y={cy - 18}
                fill="#FEF3C7" fontSize="30" fontFamily="'Space Mono', monospace" fontWeight="bold"
                textAnchor="middle" dominantBaseline="middle" letterSpacing="2"
            >
                DAY {cyclePosition.daysSinceHalving}
            </text>
            <text
                x={cx} y={cy + 8}
                fill="rgba(254,243,199,0.55)" fontSize="10" fontFamily="'Space Mono', monospace"
                textAnchor="middle" dominantBaseline="middle" letterSpacing="3"
            >
                OF CYCLE {cyclePosition.cycleNumber}
            </text>
            <text
                x={cx} y={cy + 30}
                fill={cyclePosition.phaseColor} fontSize="11" fontFamily="'Space Mono', monospace" fontWeight="bold"
                textAnchor="middle" dominantBaseline="middle" letterSpacing="3"
            >
                {cyclePosition.phase}
            </text>
        </svg>
    );
}
