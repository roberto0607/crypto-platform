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
import { isRealPair } from "@/lib/pairs";

interface AppState {
  systemStatus: SystemStatus | null;
  userStatus: UserStatus | null;
  riskStatus: RiskStatus | null;
  pairs: TradingPair[];
  assets: Asset[];
  wallets: Wallet[];
  selectedPairId: string | null;
  initialized: boolean;
  serverOffline: boolean;
  sseConnected: boolean;
  sseConnectionState: SseConnectionState;
  lastPriceTickAt: number;
  setInitialized: (initialized: boolean) => void;
  setServerOffline: (offline: boolean) => void;
  setSystemStatus: (status: SystemStatus) => void;
  setUserStatus: (status: UserStatus) => void;
  setRiskStatus: (status: RiskStatus) => void;
  setPairs: (pairs: TradingPair[]) => void;
  setAssets: (assets: Asset[]) => void;
  setWallets: (wallets: Wallet[]) => void;
  setSelectedPairId: (id: string | null) => void;
  setSseConnected: (connected: boolean) => void;
  setSseConnectionState: (state: SseConnectionState) => void;
  setLastPriceTickAt: (ts: number) => void;
}

export const useAppStore = create<AppState>((set) => ({
  systemStatus: null,
  userStatus: null,
  riskStatus: null,
  pairs: [],
  assets: [],
  wallets: [],
  selectedPairId: null,
  initialized: false,
  serverOffline: false,
  sseConnected: false,
  // Cold load starts in "initializing" (neutral), NOT "disconnected" (red OFFLINE).
  // The badge must never show OFFLINE until at least one successful connection.
  sseConnectionState: "initializing" as SseConnectionState,
  lastPriceTickAt: 0,
  setInitialized: (initialized) => set({ initialized }),
  setServerOffline: (serverOffline) => set({ serverOffline }),
  setSystemStatus: (systemStatus) => set({ systemStatus }),
  setUserStatus: (userStatus) => set({ userStatus }),
  setRiskStatus: (riskStatus) => set({ riskStatus }),
  // Filter out test fixture pairs at the chokepoint so every consumer of
  // `pairs` (asset bar, ticker, selector) inherits the filter. See lib/pairs.ts.
  setPairs: (pairs) => set({ pairs: pairs.filter(isRealPair) }),
  setAssets: (assets) => set({ assets }),
  setWallets: (wallets) => set({ wallets }),
  setSelectedPairId: (selectedPairId) => set({ selectedPairId }),
  setSseConnected: (sseConnected) => set({ sseConnected }),
  setSseConnectionState: (sseConnectionState) => set({ sseConnectionState }),
  setLastPriceTickAt: (lastPriceTickAt) => set({ lastPriceTickAt }),
}));
