import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { FeaturedMatch, PublicPlayer } from "@/api/endpoints/landing";
import { formatClock, formatSignedPct, formatSignedUsd } from "@/lib/landing";
import RaceChart from "./RaceChart";

function PlayerRow({ player, fallback, color, dashed }: { player: PublicPlayer; fallback: string; color: string; dashed: boolean }) {
  const sign = player.returnPct === null ? null : player.returnPct >= 0 ? "text-lp-accent" : "text-lp-down";
  return (
    <div className="flex items-baseline justify-between gap-3">
      <div className="flex items-center gap-2 min-w-0">
        <span
          aria-hidden="true"
          className="inline-block w-6 border-t-2 shrink-0"
          style={{ borderColor: color, borderStyle: dashed ? "dashed" : "solid" }}
        />
        <span className="truncate text-white text-[14px]">{player.handle ?? fallback}</span>
      </div>
      <div className="flex items-baseline gap-3 tabular-nums">
        {player.returnPct !== null && <span className={`text-[15px] font-bold ${sign}`}>{formatSignedPct(player.returnPct)}</span>}
        {player.pnlUsd !== null && <span className="text-[12px] text-lp-muted">{formatSignedUsd(player.pnlUsd)}</span>}
      </div>
    </div>
  );
}

export default function LiveMatchPanel({ match }: { match: FeaturedMatch }) {
  // Count down locally between the server's 5s refreshes.
  const [anchor, setAnchor] = useState(() => ({ secondsLeft: match.secondsLeft, at: Date.now() }));
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => setAnchor({ secondsLeft: match.secondsLeft, at: Date.now() }), [match.secondsLeft]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const elapsed = Math.max(0, Math.floor((now - anchor.at) / 1000));
  const secondsLeft = Math.max(0, anchor.secondsLeft - elapsed);

  const cName = match.challenger.handle ?? "Challenger";
  const oName = match.opponent.handle ?? "Opponent";

  return (
    <section aria-labelledby="lp-live-title" className="flex flex-col gap-5">
      <div className="flex items-center justify-between gap-4 text-[11px] tracking-[3px]">
        <h2 id="lp-live-title" className="flex items-center gap-2 text-lp-accent font-normal">
          <span className="w-2 h-2 rounded-full bg-lp-accent motion-safe:animate-pulse" aria-hidden="true" />
          LIVE 1V1
        </h2>
        <span className="text-lp-muted tabular-nums">
          <span className="sr-only">Time left: </span>
          {formatClock(secondsLeft)}
        </span>
      </div>

      <div className="flex flex-col gap-2">
        <PlayerRow player={match.challenger} fallback="Challenger" color="#7CFF5B" dashed={false} />
        <PlayerRow player={match.opponent} fallback="Opponent" color="#F2B84B" dashed />
      </div>

      <RaceChart series={match.series} trades={match.lastTrades} challengerName={cName} opponentName={oName} />

      {match.lastTrades.length > 0 && (
        <div>
          <h3 className="text-[11px] tracking-[3px] text-lp-muted mb-2">LAST TRADES</h3>
          <ul className="flex flex-col gap-1 text-[13px] tabular-nums">
            {match.lastTrades.map((t, i) => (
              <li key={i} className="flex gap-3">
                <span className="truncate w-32 text-white">{t.player === "challenger" ? cName : oName}</span>
                <span className={t.side === "BUY" ? "text-lp-accent" : "text-lp-down"}>{t.side}</span>
                <span className="text-white">{t.qty} {t.asset}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex items-center justify-between gap-4">
        <span className="text-[12px] text-lp-muted">{match.spectatorCount} watching</span>
        <Link
          to={`/matches/${match.matchId}/spectate`}
          className="px-5 py-2.5 border border-lp-accent text-lp-accent text-[13px] font-bold tracking-[3px] hover:bg-lp-accent hover:text-black focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lp-accent"
        >
          SPECTATE
        </Link>
      </div>
    </section>
  );
}
