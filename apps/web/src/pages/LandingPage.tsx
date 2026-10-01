import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useLandingStream } from "@/hooks/useLandingStream";
import { useQuickCall } from "@/hooks/useQuickCall";
import { useNotifyOnLive } from "@/hooks/useNotifyOnLive";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { nextPanel, type Panel } from "@/lib/landing";
import HandleForm from "@/components/landing/HandleForm";
import LiveMatchPanel from "@/components/landing/LiveMatchPanel";
import QuickCallPanel from "@/components/landing/QuickCallPanel";
import TickerFooter from "@/components/landing/TickerFooter";

export default function LandingPage() {
  const reducedMotion = usePrefersReducedMotion();
  const quick = useQuickCall();
  // Opened once the quick-call state has loaded: that request issues the anon
  // session cookie the stream uses to route this visitor's results.
  const { prices, featured, lastResult } = useLandingStream(quick.sessionReady);
  const notify = useNotifyOnLive(featured);

  const { applyStreamResult } = quick;
  useEffect(() => {
    if (lastResult) applyStreamResult(lastResult);
  }, [lastResult, applyStreamResult]);

  const [panel, setPanel] = useState<Panel>("idle");
  useEffect(() => {
    setPanel((current) => nextPanel(current, !!featured, quick.roundInProgress));
  }, [featured, quick.roundInProgress]);

  const saveStreak = quick.lastSettled?.outcome === "WIN" && quick.streak > 0 ? quick.streak : null;

  return (
    <div className="lp-root min-h-screen flex flex-col bg-tradr-bg text-white font-mono">
      <nav className="flex items-center justify-between px-4 md:px-10 h-14 border-b border-white/10">
        <span className="font-bebas text-[26px] tracking-[4px]" aria-label="TRADR">
          TR<span className="text-lp-accent">A</span>DR
        </span>
        <Link
          to="/login"
          className="text-[12px] tracking-[3px] text-lp-muted hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-lp-accent px-2 py-1"
        >
          SIGN IN
        </Link>
      </nav>

      <main className="flex-1 grid grid-cols-1 md:grid-cols-2">
        <div className="flex flex-col justify-center px-4 md:px-10 lg:px-16 py-12 md:py-16">
          <p className="flex items-center gap-2 text-[11px] tracking-[3px] text-lp-accent w-fit border border-lp-accent/40 px-3 py-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-lp-accent" aria-hidden="true" />
            SEASON 01 · 1V1 MATCHES OPEN
          </p>
          <h1 className="mt-8 font-anton uppercase leading-[0.95] whitespace-nowrap text-[clamp(44px,6.2vw,96px)]">
            Trade
            <br />
            <span className="text-lp-accent">Head-to-head.</span>
          </h1>
          <p className="mt-6 max-w-lg text-[15px] leading-7 text-lp-muted">
            Take on real traders in timed 1v1 matches on BTC, ETH and SOL — live market prices, paper money, ranked by
            return.
          </p>
          <HandleForm saveStreak={saveStreak} />
        </div>

        <div className="border-t md:border-t-0 md:border-l border-white/10 px-4 md:px-10 lg:px-14 py-10 md:py-16 flex flex-col justify-center min-h-[520px]">
          {/* Nothing until the stream says whether a match is live — never a placeholder. */}
          {featured !== undefined &&
            (panel === "live" && featured ? (
              <LiveMatchPanel match={featured} />
            ) : (
              <QuickCallPanel btc={prices.BTC} quick={quick} notify={notify} reducedMotion={reducedMotion} />
            ))}
        </div>
      </main>

      <TickerFooter prices={prices} />
    </div>
  );
}
