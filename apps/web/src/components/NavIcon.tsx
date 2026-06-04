// Dependency-free inline-SVG icon set for the sidebar rail (PR #39).
// Same pattern as NotificationBell.tsx / IndicatorToolbar.tsx — no icon library.
// Icons use stroke="currentColor"/fill="currentColor" so active/hover green
// inheritance from the NavLink is preserved. Unknown keys render nothing.

const ICONS: Record<string, JSX.Element> = {
  // Trade — candlestick bars
  trade: (
    <>
      <line x1="4" y1="2" x2="4" y2="14" />
      <rect x="2.5" y="5" width="3" height="6" fill="currentColor" stroke="none" />
      <line x1="11" y1="3" x2="11" y2="15" />
      <rect x="9.5" y="6" width="3" height="5" fill="currentColor" stroke="none" />
    </>
  ),
  // Arena — crossed swords
  arena: (
    <>
      <path d="M2.5 2.5l7 7" />
      <path d="M13.5 2.5l-7 7" />
      <path d="M9.5 9.5l1.5 1.5-2 2-1.5-1.5" />
      <path d="M6.5 9.5L5 11l2 2 1.5-1.5" />
    </>
  ),
  // Replay — rewind (<<)
  replay: (
    <>
      <path d="M8 4L3 8l5 4V4z" fill="currentColor" stroke="none" />
      <path d="M14 4L9 8l5 4V4z" fill="currentColor" stroke="none" />
    </>
  ),
  // Cycle — circular arrows
  cycle: (
    <>
      <path d="M13 7a5 5 0 0 0-8.5-2.5L2.5 6.5" />
      <path d="M2.5 3v3.5H6" />
      <path d="M3 9a5 5 0 0 0 8.5 2.5l2-2" />
      <path d="M13.5 13V9.5H10" />
    </>
  ),
  // History — clock
  history: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.5V8l2.5 1.5" />
    </>
  ),
  // Profile — user
  profile: (
    <>
      <circle cx="8" cy="5.5" r="2.5" />
      <path d="M3 13.5a5 5 0 0 1 10 0" />
    </>
  ),
  // Settings — gear
  settings: (
    <>
      <circle cx="8" cy="8" r="2" />
      <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4" />
    </>
  ),
  // Admin — shield
  admin: (
    <>
      <path d="M8 1.5l5 2v4c0 3-2.2 5.2-5 6.5C5.2 12.7 3 10.5 3 7.5v-4l5-2z" />
    </>
  ),
};

export function NavIcon({ name }: { name: string }) {
  const icon = ICONS[name];
  if (!icon) return null;
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
      {icon}
    </svg>
  );
}
