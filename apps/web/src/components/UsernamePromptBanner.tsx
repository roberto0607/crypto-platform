import { useState } from "react";
import { Link } from "react-router-dom";
import { useAuthStore } from "@/stores/authStore";

const seenKey = (userId: string) => `tradr_username_prompt_seen:${userId}`;

/**
 * One-time prompt for a user still on a generated trader_ name (an account
 * from before usernames, or one made through the API without a name). Clicking
 * through or dismissing ends it for this user in this browser; choosing a name
 * ends it everywhere.
 */
export default function UsernamePromptBanner() {
  const user = useAuthStore((s) => s.user);
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);

  if (!user || user.usernameChosen !== false) return null;
  if (dismissedFor === user.id || localStorage.getItem(seenKey(user.id))) return null;

  function markSeen(userId: string) {
    localStorage.setItem(seenKey(userId), "1");
    setDismissedFor(userId);
  }

  return (
    <div className="relative z-20 bg-blue-600/90 text-white px-4 py-2 text-center text-sm font-medium">
      <Link to="/settings" className="underline" onClick={() => markSeen(user.id)}>
        Pick your username
      </Link>
      <span> so other players can find and challenge you.</span>
      <button
        type="button"
        aria-label="Dismiss"
        className="absolute right-3 top-1/2 -translate-y-1/2 bg-transparent border-0 text-white/80 hover:text-white cursor-pointer"
        onClick={() => markSeen(user.id)}
      >
        ×
      </button>
    </div>
  );
}
