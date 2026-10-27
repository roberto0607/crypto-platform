import { create } from "zustand";
import type { UUID } from "@/types/api";

/**
 * The liquidation engine's mark per pair (SSE mark.price): the Kraken book
 * mid an ISOLATED position is judged by. `mark` is the last good one (kept
 * while paused); `paused` says the engine isn't liquidating on this pair now.
 * `receivedAt` lets readers treat a silent engine as stale (lib/leverageUi
 * positionMark).
 */
export interface MarkEntry {
  mark: number | null;
  paused: boolean;
  feed: "ok" | "stale" | "waiting" | "disconnected";
  receivedAt: number;
}

interface MarkPriceState {
  marks: Record<UUID, MarkEntry>;
  setMark: (pairId: UUID, mark: number | null, paused: boolean, feed: MarkEntry["feed"]) => void;
}

export const useMarkPriceStore = create<MarkPriceState>((set) => ({
  marks: {},
  setMark: (pairId, mark, paused, feed) =>
    set((state) => ({
      marks: {
        ...state.marks,
        [pairId]: { mark: mark ?? state.marks[pairId]?.mark ?? null, paused, feed, receivedAt: Date.now() },
      },
    })),
}));
