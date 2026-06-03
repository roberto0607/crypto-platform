import { create } from "zustand";
import type { UUID } from "@/types/api";

interface PairPricesState {
  prices: Record<UUID, number>;
  setPairPrice: (pairId: UUID, price: number) => void;
}

export const usePairPricesStore = create<PairPricesState>((set) => ({
  prices: {},
  setPairPrice: (pairId, price) =>
    set((state) => ({ prices: { ...state.prices, [pairId]: price } })),
}));
