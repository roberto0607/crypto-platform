import { create } from "zustand";

export type ThemeName = "tradr" | "tradewars";

interface ThemeState {
  currentTheme: ThemeName;
  setTheme: (theme: ThemeName) => void;
}

export const useThemeStore = create<ThemeState>((set) => ({
  currentTheme: "tradr",
  setTheme: (theme) => set({ currentTheme: theme }),
}));
