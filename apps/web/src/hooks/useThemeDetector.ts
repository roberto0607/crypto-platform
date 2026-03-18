import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { useThemeStore } from "@/stores/themeStore";
import { useAuthStore } from "@/stores/authStore";
import { useCompetitionMode } from "@/hooks/useCompetitionMode";

/**
 * Watches route + active match state to auto-switch between
 * TRADR (green) and TRADE WARS (orange/red) themes.
 * Must be called inside a Router context (e.g. App.tsx).
 */
export function useThemeDetector() {
  const location = useLocation();
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const { isInCompetition } = useCompetitionMode();
  const setTheme = useThemeStore((s) => s.setTheme);

  useEffect(() => {
    if (!isAuthenticated) {
      setTheme("tradr");
      return;
    }
    const isArena = location.pathname.startsWith("/arena");
    const shouldBeWar = isArena || isInCompetition;
    setTheme(shouldBeWar ? "tradewars" : "tradr");
  }, [location.pathname, isInCompetition, isAuthenticated, setTheme]);
}
