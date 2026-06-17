// Cycles — Bitcoin cycle-history reference.
//
// Placeholder while the factual cycle-history view (drawdowns + halvings
// table/chart) is rebuilt. No data fetching, no live calls, no AI.
export default function CyclesPage() {
  return (
    <div className="font-mono text-white/85 max-w-3xl">
      <div className="flex items-baseline gap-3">
        <h1 className="text-2xl tracking-[4px] text-tradr-green">CYCLES</h1>
        <span className="text-tradr-green/40">//</span>
      </div>

      <div className="mt-2 text-[10px] tracking-[3px] text-white/30 uppercase">
        Bitcoin cycle history — drawdowns · halvings
      </div>

      <div className="mt-8 border border-tradr-green/[0.18] bg-tradr-bg2/40 px-5 py-6">
        <div className="text-[11px] tracking-[1px] leading-6 text-white/50">
          This view is being rebuilt as a factual cycle-history reference.
          Check back soon.
        </div>
      </div>
    </div>
  );
}
