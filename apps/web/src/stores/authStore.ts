import { create } from "zustand";
import type { User } from "@/types/api";
import { bindAuthStore, setActiveCompetitionId, refreshAccessToken } from "@/api/client";
import { me, logout } from "@/api/endpoints/auth";

// HMR-safe guard: stored on globalThis so Vite hot reloads don't reset it.
// Ensures initialize() runs exactly once across StrictMode remounts AND HMR.
const _global = globalThis as any;
if (!("__tradrInitOnce" in _global)) _global.__tradrInitOnce = null;

// Session hint: the refresh_token cookie is httpOnly (invisible to JS).
// This localStorage flag lets us skip the POST /auth/refresh call entirely
// on fresh page loads where no session ever existed — avoids a noisy 401.
const SESSION_KEY = "tradr_session";

interface AuthState {
  accessToken: string | null;
  user: User | null;
  isAuthenticated: boolean;
  isInitializing: boolean;
  isAdmin: boolean;
  setAuth: (token: string, user: User) => void;
  clearAuth: () => void;
  initialize: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set, get) => {
  // Late-bind to API client interceptors (avoids circular deps)
  bindAuthStore({
    getToken: () => get().accessToken,
    setToken: (token: string) => set({ accessToken: token }),
    // Interceptor clearAuth: state-only, no API call (avoids loops)
    clearAuth: () =>
      set({
        accessToken: null,
        user: null,
        isAuthenticated: false,
        isAdmin: false,
      }),
  });

  return {
    accessToken: null,
    user: null,
    isAuthenticated: false,
    isInitializing: false,
    isAdmin: false,

    setAuth: (token: string, user: User) => {
      localStorage.setItem(SESSION_KEY, "1");
      set({
        accessToken: token,
        user,
        isAuthenticated: true,
        isAdmin: user.role === "ADMIN",
      });
    },

    clearAuth: () => {
      // Fire-and-forget logout — don't block UI on failure
      logout().catch(() => {});
      // Reset competition context
      setActiveCompetitionId(null);
      // Allow a fresh initialize cycle on next login
      _global.__tradrInitOnce = null;
      localStorage.removeItem(SESSION_KEY);
      set({
        accessToken: null,
        user: null,
        isAuthenticated: false,
        isAdmin: false,
      });
    },

    initialize: () => {
      if (_global.__tradrInitOnce) return _global.__tradrInitOnce;

      _global.__tradrInitOnce = (async () => {
        // No session hint → user never logged in (or logged out).
        // Skip the refresh call entirely to avoid a pointless 401.
        if (!localStorage.getItem(SESSION_KEY)) {
          set({ isInitializing: false });
          return;
        }

        set({ isInitializing: true });
        try {
          // Uses shared mutex — if interceptor is also refreshing, we wait on same promise
          const token = await refreshAccessToken();
          if (!token) {
            // Cookie expired or DB was wiped — clear stale hint
            localStorage.removeItem(SESSION_KEY);
            set({ isInitializing: false });
            return;
          }

          // Set token so subsequent client calls include Bearer header
          set({ accessToken: token });

          // Fetch user profile via the interceptor-enabled client
          const meRes = await me();
          const user = meRes.data.user;

          set({
            user,
            isAuthenticated: true,
            isAdmin: user.role === "ADMIN",
            isInitializing: false,
          });
        } catch {
          // Refresh failed — stay unauthenticated, no redirect
          set({ isInitializing: false });
        }
      })();

      return _global.__tradrInitOnce;
    },
  };
});
