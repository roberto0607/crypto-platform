import { useEffect, useState } from "react";
import type { PriceTick } from "@/hooks/useLandingStream";
import type { QuickCallHook } from "@/hooks/useQuickCall";
import type { CallOutcome, SettledQuickCall } from "@/api/endpoints/landing";
import { formatPrice } from "@/lib/landing";
import CountdownRing from "./CountdownRing";
import StreakMeter from "./StreakMeter";

const ROUND_MS = 60_000;

const OUTCOME_STYLE: Record<CallOutcome, { cls: string; label: string }> = {
  WIN: { cls: "bg-lp-accent", label: "win" },
  LOSS: { cls: "bg-lp-down", label: "loss" },
  PUSH: { cls: "bg-white/60", label: "push" },
  VOID: { cls: "border border-white/40", label: "void" },
};

function resultText(s: SettledQuickCall): string {
  switch (s.outcome) {
    case "WIN":
      return `WIN — BTC ${s.direction === "UP" ? "rose" : "fell"} to ${formatPrice(s.exitPrice!)}.`;
    case "LOSS":
      return `LOSS — BTC went to ${formatPrice(s.exitPrice!)}.`;
    case "PUSH":
      return "PUSH — BTC closed exactly where it started. Streak unchanged.";
    case "VOID":
      return "VOID — the price feed dropped out, so this round doesn't count. Streak unchanged.";
  }
}

export interface NotifyControl {
  supported: boolean;
  enabled: boolean;
  toggle(): void;
}

interface Props {
  btc: PriceTick | undefined;
  quick: QuickCallHook;
  notify: NotifyControl;
  reducedMotion: boolean;
}

export default function QuickCallPanel({ btc, quick, notify, reducedMotion }: Props) {
  const { round, lastSettled, history, streak, error, placing } = quick;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!round) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [round]);

  const msLeft = round ? Math.max(0, round.deadline - now) : null;
  const fraction = msLeft === null ? null : msLeft / ROUND_MS;
  const canCall = !round && !placing && !!btc;

  return (
    <section aria-labelledby="lp-qc-title" className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-4">
        <span className="text-[11px] tracking-[3px] text-lp-muted border border-white/20 px-2.5 py-1">NO LIVE MATCH</span>
        {notify.supported && (
          <button
            type="button"
            aria-pressed={notify.enabled}
            onClick={notify.toggle}
            className={`text-[11px] tracking-[3px] px-2.5 py-1 border focus-visible:outline focus-visible:outline-2 focus-visible:outline-lp-accent ${notify.enabled ? "border-lp-accent text-lp-accent" : "border-white/20 text-lp-muted hover:text-white"}`}
          >
            NOTIFY ME {notify.enabled ? "· ON" : ""}
          </button>
        )}
      </div>

      <h2 id="lp-qc-title" className="font-anton text-3xl md:text-4xl text-white uppercase tracking-wide">
        Where's BTC in 60 seconds?
      </h2>

      <CountdownRing fraction={fraction} reducedMotion={reducedMotion}>
        {btc && <span className="text-xl text-white tabular-nums">{formatPrice(btc.price)}</span>}
        {round && msLeft !== null && (
          <span className="mt-1 text-[12px] text-lp-muted tabular-nums">
            {Math.ceil(msLeft / 1000)}s · {round.call.direction} from {formatPrice(round.call.entryPrice)}
          </span>
        )}
      </CountdownRing>

      <p aria-live="polite" className="min-h-5 text-center text-[13px] text-white">
        {!round && lastSettled ? resultText(lastSettled) : ""}
      </p>

      <div className="grid grid-cols-2 gap-3">
        {(["UP", "DOWN"] as const).map((dir) => (
          <button
            key={dir}
            type="button"
            disabled={!canCall}
            onClick={() => void quick.place(dir)}
            className={`py-4 text-[15px] font-bold tracking-[4px] border disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lp-accent ${
              dir === "UP"
                ? "border-lp-accent text-lp-accent enabled:hover:bg-lp-accent enabled:hover:text-black"
                : "border-lp-down text-lp-down enabled:hover:bg-lp-down enabled:hover:text-black"
            }`}
          >
            {dir === "UP" ? "▲ UP" : "▼ DOWN"}
          </button>
        ))}
      </div>
      {error && <p role="alert" className="text-[12px] text-lp-down">{error}</p>}
      {!btc && <p className="text-[12px] text-lp-muted">Waiting for the live BTC price…</p>}

      <StreakMeter streak={streak} />

      {history.length > 0 && (
        <div>
          <h3 className="text-[11px] tracking-[3px] text-lp-muted mb-2">LAST {history.length} ROUNDS</h3>
          <ol className="flex flex-wrap gap-1" aria-label="Recent rounds, newest first">
            {history.map((h) => (
              <li
                key={h.id}
                data-testid="round-pip"
                className={`w-3 h-3 ${OUTCOME_STYLE[h.outcome].cls}`}
                aria-label={`${h.direction} call, ${OUTCOME_STYLE[h.outcome].label}`}
                title={`${h.direction} · ${h.outcome}`}
              />
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}
