// Dependency-free inline-SVG icon set for the drawing-tool strip. Same
// pattern as NavIcon.tsx / IndicatorToolbar.tsx — no icon library exists
// anywhere in this codebase.

import type { DrawingToolType } from "@/stores/drawingStore";

const ICONS: Record<DrawingToolType, JSX.Element> = {
    trendline: (
        <>
            <line x1="2" y1="13" x2="14" y2="3" />
            <circle cx="2" cy="13" r="1.4" fill="currentColor" stroke="none" />
            <circle cx="14" cy="3" r="1.4" fill="currentColor" stroke="none" />
        </>
    ),
    hline: <line x1="2" y1="8" x2="14" y2="8" />,
    hray: <line x1="6" y1="8" x2="14" y2="8" />,
    vline: <line x1="8" y1="2" x2="8" y2="14" />,
    rect: <rect x="2.5" y="4.5" width="11" height="7" />,
    fib: (
        <>
            <line x1="2" y1="13" x2="14" y2="3" />
            <line x1="3" y1="11.5" x2="7" y2="11.5" />
            <line x1="5.5" y1="8" x2="9.5" y2="8" />
            <line x1="8" y1="4.5" x2="12" y2="4.5" />
        </>
    ),
    text: (
        <>
            <line x1="3" y1="3.5" x2="13" y2="3.5" />
            <line x1="8" y1="3.5" x2="8" y2="12.5" />
        </>
    ),
};

export function DrawingToolIcon({ type }: { type: DrawingToolType }) {
    return (
        <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.4}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            className="inline-block"
        >
            {ICONS[type]}
        </svg>
    );
}

/** Measure/ruler icon — a diagonal edge with perpendicular tick marks, distinct
 * from Trendline's circle-endpoint diagonal and Fib's horizontal-rung ladder. */
export function MeasureIcon() {
    return (
        <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.4}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            className="inline-block"
        >
            <line x1="2" y1="14" x2="14" y2="2" />
            <line x1="4" y1="12" x2="5.5" y2="10.5" />
            <line x1="7" y1="9" x2="8.5" y2="7.5" />
            <line x1="10" y1="6" x2="11.5" y2="4.5" />
        </svg>
    );
}

/** Magnet toggle icon — a horseshoe magnet, distinct silhouette from the tool
 * icons above so it reads as "a different kind of control" at a glance. */
export function MagnetIcon() {
    return (
        <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.4}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            className="inline-block"
        >
            <path d="M4 2v6a4 4 0 0 0 8 0V2" />
            <path d="M4 2H2v4h2" />
            <path d="M12 2h2v4h-2" />
            <path d="M4 8h2" />
            <path d="M10 8h2" />
        </svg>
    );
}
