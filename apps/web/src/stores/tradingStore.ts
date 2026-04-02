import { create } from "zustand";
import type {
  OrderBook,
  Snapshot,
  Order,
  Fill,
  OrderSide,
  OrderType,
  DecimalString,
  UUID,
} from "@/types/api";
import {
  getOrderBook,
  getKrakenBook,
  getSnapshot,
  listOrders,
  placeOrder,
  cancelOrder as cancelOrderApi,
} from "@/api/endpoints/trading";
import { useAppStore } from "./appStore";
import { setActiveCompetitionId } from "@/api/client";

export interface RecentTrade {
  tradeId: UUID;
  pairId: UUID;
  side: OrderSide;
  price: DecimalString;
  qty: DecimalString;
  quoteAmount: DecimalString;
  ts: number;
}

const MAX_RECENT_TRADES = 50;

const INDICATOR_STORAGE_KEY = "indicator-config";

const defaultIndicatorConfig = {
  // Standard
  ema20: false,
  ema50: false,
  ema200: false,
  vwap: false,
  bollingerBands: false,
  volume: false,
  rsi: false,
  macd: false,
  atr: false,
  delta: false,
  // Advanced
  keyLevels: false,
  liquidityZones: false,
  orderBlocks: false,
  cvd: true,
  marketIntelligence: false,
};

type IndicatorConfig = typeof defaultIndicatorConfig;

function loadIndicatorConfig(): IndicatorConfig {
  try {
    const stored = localStorage.getItem(INDICATOR_STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      // Strip removed keys — only keep keys that exist in defaults
      const cleaned: Record<string, boolean> = {};
      for (const key of Object.keys(defaultIndicatorConfig)) {
        cleaned[key] = typeof parsed[key] === "boolean" ? parsed[key] : (defaultIndicatorConfig as Record<string, boolean>)[key]!;
      }
      return cleaned as IndicatorConfig;
    }
  } catch { /* ignore */ }
  return { ...defaultIndicatorConfig };
}

interface TradingState {
  selectedPairId: string | null;
  orderBook: OrderBook | null;
  snapshot: Snapshot | null;
  openOrders: Order[];
  recentTrades: RecentTrade[];

  // Order form state
  orderSide: OrderSide;
  orderType: OrderType;
  qty: string;
  limitPrice: string;

  // Competition context
  activeCompetitionId: string | null;

  // Loading states
  bookLoading: boolean;
  orderSubmitting: boolean;

  // Bottom panel tab
  bottomTab: "market" | "orders" | "positions" | "triggers" | "setup" | "liquidation";
  setBottomTab: (tab: "market" | "orders" | "positions" | "triggers" | "setup" | "liquidation") => void;

  // Indicator config (persisted to localStorage)
  indicatorConfig: IndicatorConfig;
  toggleIndicator: (key: keyof IndicatorConfig) => void;

  // Actions
  setActiveCompetition: (id: string | null) => void;
  selectPair: (pairId: string) => void;
  setOrderSide: (side: OrderSide) => void;
  setOrderType: (type: OrderType) => void;
  setQty: (qty: string) => void;
  setLimitPrice: (price: string) => void;
  refreshBook: () => Promise<void>;
  refreshSnapshot: () => Promise<void>;
  refreshOpenOrders: () => Promise<void>;
  submitOrder: () => Promise<{ order: Order; fills: Fill[] }>;
  cancelOrder: (orderId: string) => Promise<void>;

  // SSE-driven setters
  setOrderBook: (book: OrderBook) => void;
  setSnapshot: (snapshot: Snapshot) => void;
  updateOrder: (orderId: string, status: string, filledQty: string) => void;
  addRecentTrade: (trade: RecentTrade) => void;
  removeOrder: (orderId: string) => void;
}

export const useTradingStore = create<TradingState>((set, get) => ({
  selectedPairId: null,
  orderBook: null,
  snapshot: null,
  openOrders: [],
  recentTrades: [],

  orderSide: "BUY",
  orderType: "MARKET",
  qty: "",
  limitPrice: "",

  activeCompetitionId: null,

  bottomTab: "market",
  setBottomTab: (bottomTab) => set({ bottomTab }),

  bookLoading: false,
  orderSubmitting: false,

  indicatorConfig: loadIndicatorConfig(),

  toggleIndicator: (key: keyof IndicatorConfig) => {
    const config = { ...get().indicatorConfig, [key]: !get().indicatorConfig[key] };
    localStorage.setItem(INDICATOR_STORAGE_KEY, JSON.stringify(config));
    set({ indicatorConfig: config });
  },

  setActiveCompetition: (id: string | null) => {
    setActiveCompetitionId(id);
    set({ activeCompetitionId: id });

    // Refresh all trading data for the new context
    const { selectedPairId, refreshBook, refreshSnapshot, refreshOpenOrders } = get();
    if (selectedPairId) {
      refreshBook();
      refreshSnapshot();
      refreshOpenOrders();
    }
  },

  selectPair: (pairId: string) => {
    set({
      selectedPairId: pairId,
      orderBook: null,
      snapshot: null,
      openOrders: [],
      recentTrades: [],
      qty: "",
      limitPrice: "",
    });
    // Refresh all data for the new pair
    const state = get();
    state.refreshBook();
    state.refreshSnapshot();
    state.refreshOpenOrders();
  },

  setOrderSide: (orderSide) => set({ orderSide }),
  setOrderType: (orderType) => set({ orderType }),
  setQty: (qty) => set({ qty }),
  setLimitPrice: (limitPrice) => set({ limitPrice }),

  refreshBook: async () => {
    const pairId = get().selectedPairId;
    if (!pairId) return;
    set({ bookLoading: true });
    try {
      // Try Kraken cached book first (real exchange data)
      const pair = useAppStore.getState().pairs.find((p) => p.id === pairId);
      if (pair) {
        const res = await getKrakenBook(pair.symbol);
        if (get().selectedPairId === pairId && res.data.book.bids.length > 0) {
          set({ orderBook: res.data.book, bookLoading: false });
          return;
        }
      }
      // Fallback to internal order book
      const res = await getOrderBook(pairId);
      if (get().selectedPairId === pairId) {
        set({ orderBook: res.data.book, bookLoading: false });
      }
    } catch {
      if (get().selectedPairId === pairId) {
        set({ bookLoading: false });
      }
    }
  },

  refreshSnapshot: async () => {
    const pairId = get().selectedPairId;
    if (!pairId) return;
    try {
      const res = await getSnapshot(pairId);
      if (get().selectedPairId === pairId) {
        set({ snapshot: res.data.snapshot });
      }
    } catch {
      // Non-fatal
    }
  },

  refreshOpenOrders: async () => {
    const pairId = get().selectedPairId;
    if (!pairId) return;
    try {
      const res = await listOrders({ pairId, status: "OPEN", limit: 50 });
      if (get().selectedPairId === pairId) {
        set({ openOrders: res.data.orders });
      }
    } catch {
      // Non-fatal
    }
  },

  submitOrder: async () => {
    const { selectedPairId, orderSide, orderType, qty, limitPrice } = get();
    if (!selectedPairId || !qty) {
      throw new Error("Missing required order fields");
    }

    set({ orderSubmitting: true });

    const idempotencyKey = crypto.randomUUID();

    try {
      const res = await placeOrder(
        {
          pairId: selectedPairId,
          side: orderSide,
          type: orderType,
          qty,
          limitPrice: orderType === "LIMIT" ? limitPrice : undefined,
        },
        idempotencyKey,
      );

      set({ orderSubmitting: false, qty: "", limitPrice: "" });

      // Refresh open orders after placement
      get().refreshOpenOrders();

      return { order: res.data.order, fills: res.data.fills };
    } catch (err) {
      set({ orderSubmitting: false });
      throw err;
    }
  },

  cancelOrder: async (orderId: string) => {
    // Optimistic removal
    const prevOrders = get().openOrders;
    set({ openOrders: prevOrders.filter((o) => o.id !== orderId) });

    try {
      await cancelOrderApi(orderId);
    } catch {
      // Revert on failure
      set({ openOrders: prevOrders });
      throw new Error("Failed to cancel order");
    }
  },

  // SSE-driven setters
  setOrderBook: (orderBook) => set({ orderBook }),
  setSnapshot: (snapshot) => set({ snapshot }),

  updateOrder: (orderId, status, filledQty) => {
    const orders = get().openOrders;
    if (status === "FILLED" || status === "CANCELLED") {
      // Remove completed/cancelled orders
      set({ openOrders: orders.filter((o) => o.id !== orderId) });
    } else {
      // Update in-place
      set({
        openOrders: orders.map((o) =>
          o.id === orderId ? { ...o, status: status as Order["status"], qty_filled: filledQty } : o,
        ),
      });
    }
  },

  addRecentTrade: (trade) => {
    const { recentTrades, selectedPairId } = get();
    // Only add trades for the selected pair
    if (trade.pairId !== selectedPairId) return;
    set({
      recentTrades: [trade, ...recentTrades].slice(0, MAX_RECENT_TRADES),
    });
  },

  removeOrder: (orderId) => {
    set({ openOrders: get().openOrders.filter((o) => o.id !== orderId) });
  },
}));
