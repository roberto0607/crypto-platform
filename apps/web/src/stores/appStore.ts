import { create } from "zustand";
import type {
  SystemStatus,
  UserStatus,
  RiskStatus,
  TradingPair,
  Asset,
  Wallet,
} from "@/types/api";

interface AppState {
  systemStatus: SystemStatus | null;
  userStatus: UserStatus | null;
  riskStatus: RiskStatus | null;
  pairs: TradingPair[];
  assets: Asset[];
  wallets: Wallet[];
  selectedPairId: string | null;
  initialized: boolean;
  sseConnected: boolean;
  setInitialized: (initialized: boolean) => void;
  setSystemStatus: (status: SystemStatus) => void;
  setUserStatus: (status: UserStatus) => void;
  setRiskStatus: (status: RiskStatus) => void;
  setPairs: (pairs: TradingPair[]) => void;
  setAssets: (assets: Asset[]) => void;
  setWallets: (wallets: Wallet[]) => void;
  setSelectedPairId: (id: string | null) => void;
  setSseConnected: (connected: boolean) => void;
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
  sseConnected: false,
  setInitialized: (initialized) => set({ initialized }),
  setSystemStatus: (systemStatus) => set({ systemStatus }),
  setUserStatus: (userStatus) => set({ userStatus }),
  setRiskStatus: (riskStatus) => set({ riskStatus }),
  setPairs: (pairs) => set({ pairs }),
  setAssets: (assets) => set({ assets }),
  setWallets: (wallets) => set({ wallets }),
  setSelectedPairId: (selectedPairId) => set({ selectedPairId }),
  setSseConnected: (sseConnected) => set({ sseConnected }),
}));
