import { create } from "zustand";
import type {
  SystemStatus,
  UserStatus,
  RiskStatus,
  TradingPair,
  Asset,
  Wallet,
} from "@/types/api";
import type { SseConnectionState } from "@/api/sse";
import { listWallets } from "@/api/endpoints/wallets";
import { getMatchWallets } from "@/api/endpoints/matches";

interface AppState {
  systemStatus: SystemStatus | null;
  userStatus: UserStatus | null;
  riskStatus: RiskStatus | null;
  pairs: TradingPair[];
  // Flips true after the first successful GET /pairs and stays true. Lets
  // consumers tell "pairs haven't loaded yet" apart from "pairs loaded and
  // came back empty" — the two were previously indistinguishable ([] for both).
  pairsLoaded: boolean;
  assets: Asset[];
  wallets: Wallet[];
  selectedPairId: string | null;
  initialized: boolean;
  serverOffline: boolean;
  sseConnected: boolean;
  sseConnectionState: SseConnectionState;
  /** Browser time of the last SSE liveness message (price.tick or ping). */
  lastPriceTickAt: number;
  /** Browser-clock estimate of when the server's freshest price for the
   *  subscribed pair was produced: now on a price.tick, now − priceAgeMs on a
   *  ping. null = unknown (nothing subscribed yet / new stream). */
  priceFreshAt: number | null;
  setInitialized: (initialized: boolean) => void;
  setServerOffline: (offline: boolean) => void;
  setSystemStatus: (status: SystemStatus) => void;
  setUserStatus: (status: UserStatus) => void;
  setRiskStatus: (status: RiskStatus) => void;
  setPairs: (pairs: TradingPair[]) => void;
  setAssets: (assets: Asset[]) => void;
  setWallets: (wallets: Wallet[]) => void;
  /**
   * The user's wallets in their active match (migration 095): a match order
   * trades these, never free-play. Null outside a match.
   */
  matchWallets: { matchId: string; wallets: Wallet[] } | null;
  /** Load (or with null, clear) the active match's wallets. */
  loadMatchWallets: (matchId: string | null) => Promise<void>;
  /** Patch one wallet (free-play or match — whichever set holds it) from `wallet.updated`. */
  applyWalletUpdate: (u: { walletId: string; balance: string; reserved: string }) => void;
  /** Re-fetch every wallet (after an SSE reconnect — events may have been missed). */
  refreshWallets: () => Promise<void>;
  setSelectedPairId: (id: string | null) => void;
  setSseConnected: (connected: boolean) => void;
  setSseConnectionState: (state: SseConnectionState) => void;
  setLastPriceTickAt: (ts: number) => void;
  setPriceFreshAt: (ts: number | null) => void;
}

export const useAppStore = create<AppState>((set, get) => ({
  systemStatus: null,
  userStatus: null,
  riskStatus: null,
  pairs: [],
  pairsLoaded: false,
  assets: [],
  wallets: [],
  matchWallets: null,
  selectedPairId: null,
  initialized: false,
  serverOffline: false,
  sseConnected: false,
  // Cold load starts in "initializing" (neutral), NOT "disconnected" (red OFFLINE).
  // The badge must never show OFFLINE until at least one successful connection.
  sseConnectionState: "initializing" as SseConnectionState,
  lastPriceTickAt: 0,
  priceFreshAt: null,
  setInitialized: (initialized) => set({ initialized }),
  setServerOffline: (serverOffline) => set({ serverOffline }),
  setSystemStatus: (systemStatus) => set({ systemStatus }),
  setUserStatus: (userStatus) => set({ userStatus }),
  setRiskStatus: (riskStatus) => set({ riskStatus }),
  // Test-fixture pairs are excluded server-side (GET /pairs only returns
  // pairs with an active exchange_symbol_map row) — no client-side filter
  // needed. See pairRepo.ts's listActivePairsForDisplay().
  setPairs: (pairs) => set({ pairs, pairsLoaded: true }),
  setAssets: (assets) => set({ assets }),
  setWallets: (wallets) => set({ wallets }),
  loadMatchWallets: async (matchId) => {
    if (!matchId) {
      set({ matchWallets: null });
      return;
    }
    try {
      const res = await getMatchWallets(matchId);
      set({ matchWallets: { matchId, wallets: res.data.wallets } });
    } catch {
      // Keep whatever was loaded; the next reconnect or match change retries.
    }
  },
  applyWalletUpdate: ({ walletId, balance, reserved }) =>
    set((s) => {
      const patch = (w: Wallet) => (w.id === walletId ? { ...w, balance, reserved } : w);
      return {
        wallets: s.wallets.map(patch),
        matchWallets: s.matchWallets
          ? { ...s.matchWallets, wallets: s.matchWallets.wallets.map(patch) }
          : null,
      };
    }),
  refreshWallets: async () => {
    try {
      const res = await listWallets();
      set({ wallets: res.data.wallets });
    } catch {
      // Keep the last known balances; the next wallet.updated or reconnect retries.
    }
    const match = get().matchWallets;
    if (match) await get().loadMatchWallets(match.matchId);
  },
  setSelectedPairId: (selectedPairId) => set({ selectedPairId }),
  setSseConnected: (sseConnected) => set({ sseConnected }),
  setSseConnectionState: (sseConnectionState) => set({ sseConnectionState }),
  setLastPriceTickAt: (lastPriceTickAt) => set({ lastPriceTickAt }),
  setPriceFreshAt: (priceFreshAt) => set({ priceFreshAt }),
}));
