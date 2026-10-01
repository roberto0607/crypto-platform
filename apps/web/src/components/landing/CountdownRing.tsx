import type { ReactNode } from "react";

interface Props {
  /** 0..1 of the round remaining; null when no round is running (full ring). */
  fraction: number | null;
  reducedMotion: boolean;
  children: ReactNode;
}

const R = 54;
const C = 2 * Math.PI * R;

export default function CountdownRing({ fraction, reducedMotion, children }: Props) {
  const remaining = fraction ?? 1;
  return (
    <div className="relative w-44 h-44 mx-auto">
      <svg viewBox="0 0 120 120" className="absolute inset-0 w-full h-full -rotate-90" aria-hidden="true">
        <circle cx="60" cy="60" r={R} fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth="4" />
        <circle
          cx="60"
          cy="60"
          r={R}
          fill="none"
          stroke={fraction === null ? "rgba(124,255,91,0.35)" : "#7CFF5B"}
          strokeWidth="4"
          strokeLinecap="round"
          strokeDasharray={C}
          strokeDashoffset={C * (1 - remaining)}
          style={reducedMotion ? undefined : { transition: "stroke-dashoffset 250ms linear" }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center">{children}</div>
    </div>
  );
}
