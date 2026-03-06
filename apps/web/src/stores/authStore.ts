import { create } from "zustand";
import axios from "axios";
import type { User, RefreshResponse } from "@/types/api";
import { bindAuthStore, setActiveCompetitionId } from "@/api/client";
import { me, logout } from "@/api/endpoints/auth";

const API_BASE = import.meta.env.VITE_API_BASE ?? "/api";

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

    setAuth: (token: string, user: User) =>
      set({
        accessToken: token,
        user,
        isAuthenticated: true,
        isAdmin: user.role === "ADMIN",
      }),

    clearAuth: () => {
      // Fire-and-forget logout — don't block UI on failure
      logout().catch(() => {});
      // Reset competition context
      setActiveCompetitionId(null);
      set({
        accessToken: null,
        user: null,
        isAuthenticated: false,
        isAdmin: false,
      });
    },

    initialize: async () => {
      set({ isInitializing: true });
      try {
        // Raw axios bypasses 401 interceptor — silent fail if no cookie
        const refreshRes = await axios.post<RefreshResponse>(
          `${API_BASE}/auth/refresh`,
          {},
          { withCredentials: true },
        );
        const token = refreshRes.data.accessToken;

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
    },
  };
});
