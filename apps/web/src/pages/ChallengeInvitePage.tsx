import { Navigate, useParams } from "react-router-dom";

/** /challenge/:username, the link players share. ChallengeBox does the rest. */
export default function ChallengeInvitePage() {
  const { username = "" } = useParams();
  return <Navigate to={`/arena?challenge=${encodeURIComponent(username)}`} replace />;
}
