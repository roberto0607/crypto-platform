import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { getPlayer, type PublicPlayer } from "@/api/endpoints/users";
import { useAuthStore } from "@/stores/authStore";

const MONO = "'Space Mono', monospace";

/** A player's public card, with the way to challenge them. */
export default function PlayerProfilePage() {
  const { username = "" } = useParams();
  const navigate = useNavigate();
  const userId = useAuthStore((s) => s.user?.id);
  const [player, setPlayer] = useState<PublicPlayer | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setPlayer(null);
    setFailure(null);
    getPlayer(username)
      .then(({ data }) => { if (!cancelled) setPlayer(data.player); })
      .catch((err) => {
        if (cancelled) return;
        setFailure(err?.response?.status === 404 ? "Player not found." : "Couldn't load this player. Try again.");
      });
    return () => { cancelled = true; };
  }, [username]);

  if (failure) {
    return <div style={{ fontFamily: MONO, fontSize: 12, letterSpacing: 2, padding: 24 }}>{failure}</div>;
  }
  if (!player) return null;

  return (
    <div style={{ fontFamily: MONO, padding: 24, position: "relative", zIndex: 10 }}>
      <div style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: 32, letterSpacing: 4, color: "#fff" }}>
        @{player.username}
      </div>
      <div style={{ display: "flex", gap: 16, alignItems: "center", marginTop: 8, fontSize: 12, flexWrap: "wrap" }}>
        <span style={{ color: "#00ff41", letterSpacing: 2 }}>{player.tier}</span>
        <span style={{ color: "#FF6B00" }}>{player.elo} ELO</span>
        <span style={{ color: "rgba(255,255,255,0.6)" }}>{player.wins}W – {player.losses}L</span>
      </div>
      {player.id !== userId && (
        <button
          type="button"
          onClick={() => navigate(`/arena?challenge=${encodeURIComponent(player.username)}`)}
          style={{
            marginTop: 20,
            background: "#FF6B00",
            border: 0,
            color: "#000",
            padding: "10px 18px",
            fontFamily: MONO,
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: 2,
            cursor: "pointer",
          }}
        >
          ⚔️ CHALLENGE
        </button>
      )}
    </div>
  );
}
