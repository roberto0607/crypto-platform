import { useEffect, useRef } from "react";
import { useAuthStore } from "@/stores/authStore";
import { refreshAccessToken } from "@/api/client";

// Access token TTL is 900s (15 min). Refresh 1 minute before expiry.
const REFRESH_INTERVAL_MS = 14 * 60 * 1000; // 14 minutes

export function useRefreshTokenKeepAlive() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!isAuthenticated) return;

    function scheduleRefresh() {
      timerRef.current = setTimeout(async () => {
        try {
          const token = await refreshAccessToken();
          if (token) {
            useAuthStore.getState().setAuth(
              token,
              useAuthStore.getState().user!,
            );
          }
        } catch {
          // 401 interceptor will handle the failure
        }
        // Schedule next refresh regardless
        scheduleRefresh();
      }, REFRESH_INTERVAL_MS);
    }

    scheduleRefresh();

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [isAuthenticated]);
}
