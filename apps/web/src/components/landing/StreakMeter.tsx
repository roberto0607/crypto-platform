const PIPS = 5;

export default function StreakMeter({ streak }: { streak: number }) {
  return (
    <div className="flex items-center gap-3" role="img" aria-label={`Streak ${streak} of ${PIPS}`}>
      <span className="text-[11px] tracking-[3px] text-lp-muted">STREAK</span>
      <div className="flex gap-1.5">
        {Array.from({ length: PIPS }, (_, i) => (
          <span
            key={i}
            data-testid="streak-pip"
            data-filled={i < streak}
            className={`w-5 h-2 ${i < streak ? "bg-lp-accent" : "bg-white/15"}`}
          />
        ))}
      </div>
    </div>
  );
}
