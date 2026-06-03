import { create } from "zustand";
import type { UUID } from "@/types/api";

export interface DailyOpen {
  open: number;
  dateUTC: string; // YYYY-MM-DD
}

interface DailyOpenState {
  opens: Record<UUID, DailyOpen>;
  setDailyOpen: (pairId: UUID, open: number) => void;
}

export const useDailyOpenStore = create<DailyOpenState>((set) => ({
  opens: {},
  setDailyOpen: (pairId, open) =>
    set((state) => ({
      opens: {
        ...state.opens,
        // dateUTC computed from current clock — tests use vi.useFakeTimers
        // to make this deterministic. The behavior we're encoding is:
        // "stamp with today's UTC date at call time, atomically with the open".
        [pairId]: { open, dateUTC: new Date().toISOString().slice(0, 10) },
      },
    })),
}));
