import { create } from "zustand";

interface AuthState {
  accessToken: string | null;
  user: { id: string; role: string } | null;
  isAuthenticated: boolean;
  setAuth: (token: string, user: { id: string; role: string }) => void;
  clearAuth: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  accessToken: null,
  user: null,
  isAuthenticated: false,
  setAuth: (token, user) =>
    set({ accessToken: token, user, isAuthenticated: true }),
  clearAuth: () =>
    set({ accessToken: null, user: null, isAuthenticated: false }),
}));
