import { useNavigate } from "react-router-dom";
import { useActiveMatchStore } from "@/stores/activeMatchStore";
import { useAuthStore } from "@/stores/authStore";
import { MatchEndOverlay } from "./MatchEndOverlay";

/** The result of a finished match, over whichever page the player is on. */
export function MatchEndGate() {
  const navigate = useNavigate();
  const userId = useAuthStore((s) => s.user?.id);
  const endedMatch = useActiveMatchStore((s) => s.endedMatch);
  const dismiss = useActiveMatchStore((s) => s.dismissEndedMatch);
  if (!endedMatch || !userId) return null;

  return (
    <MatchEndOverlay
      match={endedMatch}
      userId={userId}
      onBackToArena={() => {
        dismiss();
        navigate("/arena");
      }}
      // The gate lives in AppLayout, so a route change alone leaves this on top.
      onViewBreakdown={() => {
        dismiss();
        navigate(`/matches/${endedMatch.id}/breakdown`);
      }}
    />
  );
}
