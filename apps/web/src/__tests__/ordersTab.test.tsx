import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

// ── Mock heavy dependencies before importing TradingPage ──

// CandlestickChart — canvas-based, cannot render in jsdom
vi.mock("@/components/trading/CandlestickChart", () => ({
  CandlestickChart: () => <div data-testid="mock-chart">CHART</div>,
}));

// API calls
vi.mock("@/api/endpoints/analytics", () => ({
  getPositions: vi.fn().mockResolvedValue({ data: { positions: [] } }),
}));
vi.mock("@/api/endpoints/journal", () => ({
  getJournal: vi.fn().mockResolvedValue({ data: { trades: [] } }),
}));
const mockPlaceOrder = vi.fn().mockResolvedValue({ data: { order: {}, fills: [] } });
vi.mock("@/api/endpoints/trading", () => ({
  placeOrder: (...args: unknown[]) => mockPlaceOrder(...args),
  getOrderBook: vi.fn().mockResolvedValue({ data: { book: { bids: [], asks: [] } } }),
  getKrakenBook: vi.fn().mockResolvedValue({ data: { book: { bids: [], asks: [] } } }),
  getSnapshot: vi.fn().mockResolvedValue({ data: { snapshot: null } }),
  listOrders: vi.fn().mockResolvedValue({ data: { orders: [] } }),
  cancelOrder: vi.fn().mockResolvedValue({}),
}));
vi.mock("@/api/client", () => ({
  default: {
    get: vi.fn().mockResolvedValue({ data: {} }),
    post: vi.fn().mockResolvedValue({ data: {} }),
    interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } },
  },
  setActiveCompetitionId: vi.fn(),
  getActiveCompetitionId: vi.fn().mockReturnValue(null),
  bindAuthStore: vi.fn(),
  refreshAccessToken: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/hooks/useCompetitionMode", () => ({
  useCompetitionMode: () => ({ isInCompetition: false, activeMatch: null, refreshMatch: vi.fn() }),
}));

// ── Now import stores and page ──
import { useAppStore } from "@/stores/appStore";
import { useTradingStore } from "@/stores/tradingStore";
import TradingPage from "@/pages/TradingPage";
import type { Order, TradingPair } from "@/types/api";

// ── Test fixtures ──
const PAIR: TradingPair = {
  id: "pair-1",
  base_asset_id: "btc-asset",
  quote_asset_id: "usd-asset",
  symbol: "BTC/USD",
  last_price: "50000.00",
  is_active: true,
  taker_fee_bps: 10,
  maker_fee_bps: 5,
  min_qty: "0.0001",
  tick_size: "0.01",
  created_at: "",
  updated_at: "",
} as TradingPair;

function makeOrder(overrides: Partial<Order>): Order {
  return {
    id: "order-1",
    user_id: "user-1",
    pair_id: "pair-1",
    side: "BUY",
    type: "LIMIT",
    qty: "0.5",
    qty_filled: "0",
    limit_price: "49000.00",
    status: "OPEN",
    reserved_amount: "24500",
    created_at: "",
    updated_at: "",
    ...overrides,
  };
}

function renderPage() {
  return render(
    <MemoryRouter>
      <TradingPage />
    </MemoryRouter>,
  );
}

// ── Helpers to set store state ──
function seedStores(orders: Order[]) {
  useAppStore.setState({
    pairs: [PAIR],
    assets: [],
    wallets: [{ id: "w1", user_id: "user-1", asset_id: "usd-asset", balance: "100000", reserved: "0", created_at: "", updated_at: "" }],
    initialized: true,
  } as any);
  useTradingStore.setState({
    selectedPairId: "pair-1",
    openOrders: orders,
    orderBook: null,
    snapshot: { last: "50000", bid: "49999", ask: "50001", volume_24h: "100" },
    recentTrades: [],
    orderSide: "BUY",
    orderType: "MARKET",
    qty: "",
    limitPrice: "",
    activeCompetitionId: null,
    bookLoading: false,
    orderSubmitting: false,
    bottomTab: "market",
  } as any);
}

describe("Orders tab — action column", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPlaceOrder.mockResolvedValue({ data: { order: {}, fills: [] } });
  });

  it("shows ✕ CANCEL button for OPEN LIMIT order", () => {
    seedStores([makeOrder({ id: "lim-1", type: "LIMIT", status: "OPEN" })]);
    renderPage();
    expect(screen.getByText("\u2715 CANCEL")).toBeInTheDocument();
  });

  it("shows ✕ CANCEL button for PARTIALLY_FILLED LIMIT order", () => {
    seedStores([makeOrder({ id: "lim-2", type: "LIMIT", status: "PARTIALLY_FILLED", qty_filled: "0.1" })]);
    renderPage();
    expect(screen.getByText("\u2715 CANCEL")).toBeInTheDocument();
  });

  it("shows CLOSE LONG button for OPEN MARKET BUY order", () => {
    seedStores([makeOrder({ id: "mkt-1", type: "MARKET", status: "OPEN", side: "BUY", limit_price: null })]);
    renderPage();
    expect(screen.getByText("CLOSE LONG")).toBeInTheDocument();
  });

  it("shows CLOSE SHORT button for OPEN MARKET SELL order", () => {
    seedStores([makeOrder({ id: "mkt-2", type: "MARKET", status: "OPEN", side: "SELL", limit_price: null })]);
    renderPage();
    expect(screen.getByText("CLOSE SHORT")).toBeInTheDocument();
  });

  it("shows no action button for FILLED order", () => {
    seedStores([makeOrder({ id: "filled-1", type: "LIMIT", status: "FILLED" })]);
    renderPage();
    // The row should render with an empty action cell
    const rows = screen.getAllByRole("row");
    // rows[0] = thead, rows[1] = the order row
    const actionCell = rows[1]!.querySelectorAll("td")[4]!;
    expect(actionCell.querySelector("button")).toBeNull();
  });

  it("clicking CANCEL calls cancelOrder with correct id", async () => {
    const mockCancelOrder = vi.fn().mockResolvedValue(undefined);
    useTradingStore.setState({ cancelOrder: mockCancelOrder } as any);
    seedStores([makeOrder({ id: "cancel-me", type: "LIMIT", status: "OPEN" })]);
    // Re-apply cancelOrder after seedStores (which may overwrite)
    useTradingStore.setState({ cancelOrder: mockCancelOrder } as any);

    renderPage();
    const user = userEvent.setup();
    await user.click(screen.getByText("\u2715 CANCEL"));

    expect(mockCancelOrder).toHaveBeenCalledWith("cancel-me");
  });

  it("clicking CLOSE LONG calls placeOrder with opposite side SELL", async () => {
    seedStores([makeOrder({ id: "close-me", type: "MARKET", status: "OPEN", side: "BUY", limit_price: null })]);
    renderPage();
    const user = userEvent.setup();
    await user.click(screen.getByText("CLOSE LONG"));

    expect(mockPlaceOrder).toHaveBeenCalledWith(
      expect.objectContaining({ pairId: "pair-1", side: "SELL", type: "MARKET" }),
      expect.any(String),
    );
  });

  it("does not render the old tr-close-btn in the right panel", () => {
    seedStores([]);
    const { container } = renderPage();
    expect(container.querySelector(".tr-close-btn")).toBeNull();
    expect(container.querySelector(".tr-close-section")).toBeNull();
  });
});
