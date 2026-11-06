import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/components/trading/CandlestickChart", () => ({ CandlestickChart: () => <div data-testid="chart" /> }));
vi.mock("@/components/trading/TradeToolbar", () => ({ TradeToolbar: () => <div data-testid="toolbar" /> }));
vi.mock("@/components/trading/UnifiedOrderPanel", () => ({ UnifiedOrderPanel: () => <div data-testid="order-panel" /> }));
vi.mock("@/components/trading/OrderDock", () => ({ default: () => <div data-testid="dock" /> }));
vi.mock("@/components/arena/MatchChatPanel", () => ({
  MatchChatPanel: (p: { isOpen: boolean; matchId: string }) => <div data-testid="chat" data-open={p.isOpen} data-match={p.matchId} />,
}));
vi.mock("@/api/endpoints/analytics", () => ({ getPositions: vi.fn().mockResolvedValue({ data: { positions: [] } }) }));
vi.mock("@/api/endpoints/candles", () => ({ getCandles: vi.fn().mockResolvedValue({ data: { candles: [] } }) }));
vi.mock("@/api/client", async (orig) => ({
  ...(await orig<typeof import("@/api/client")>()),
  default: { get: vi.fn().mockResolvedValue({ data: {} }) },
}));
vi.mock("@/hooks/useCompetitionMode", async () => {
  const { useActiveMatchStore } = await import("@/stores/activeMatchStore");
  return {
    useCompetitionMode: () => ({
      isInCompetition: useActiveMatchStore((s) => s.isInCompetition),
      activeMatch: useActiveMatchStore((s) => s.activeMatch),
      refreshMatch: async () => {},
    }),
  };
});

import TradingPage from "@/pages/TradingPage";
import ToastProvider from "@/components/ToastProvider";
import { useActiveMatchStore } from "@/stores/activeMatchStore";
import { useAppStore } from "@/stores/appStore";
import { useAuthStore } from "@/stores/authStore";
import { useTradingStore } from "@/stores/tradingStore";
import type { Match } from "@/api/endpoints/matches";
import type { MessageReceivedEvent, TradingPair } from "@/types/api";

const PAIR = { id: "p1", symbol: "BTC/USD" } as TradingPair;
const MATCH = {
  id: "m1", status: "ACTIVE", challenger_id: "me", opponent_id: "opp", challenger_name: "alice", opponent_name: "bob",
  starting_capital: "100000", duration_hours: 24, challenger_pnl_pct: "0", opponent_pnl_pct: "0",
  ends_at: new Date(Date.now() + 3_600_000).toISOString(),
} as unknown as Match;
const mount = () => render(<ToastProvider><TradingPage /></ToastProvider>);
const chatMessage = (conversationType: string) => act(() => {
  window.dispatchEvent(new CustomEvent("sse:message.received", { detail: { conversationType } as MessageReceivedEvent }));
});

beforeEach(() => {
  useAuthStore.setState({ user: { id: "me" } as never });
  useAppStore.setState({ pairs: [PAIR], pairsLoaded: true });
  useTradingStore.setState({ selectedPairId: "p1", orderBook: null } as never);
  useActiveMatchStore.getState().setActiveMatch(null);
});

describe("/trade with no match", () => {
  it("no header, no switch, the same page as ever", () => {
    mount();
    expect(screen.getByTestId("toolbar")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "FORFEIT" })).toBeNull();
    expect(screen.queryByRole("radio", { name: "MATCH" })).toBeNull();
  });
});

describe("/trade in a live match", () => {
  beforeEach(() => useActiveMatchStore.getState().setActiveMatch(MATCH));

  it("the full trade page, with the match header on top", () => {
    mount();
    for (const id of ["toolbar", "chart", "order-panel", "dock"]) expect(screen.getByTestId(id)).toBeTruthy();
    const header = document.querySelector(".mt-header")!;
    expect(header.compareDocumentPosition(screen.getByTestId("toolbar")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole("button", { name: "FORFEIT" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /CHAT/ })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "MATCH" })).toBeChecked();
  });

  it("the old bottom bar is gone", () => {
    mount();
    expect(screen.queryByText(/⚔ 1V1/)).toBeNull();
  });

  it("chat opens in the chart area, never in the order panel", async () => {
    mount();
    await userEvent.click(screen.getByRole("button", { name: /CHAT/ }));
    const chat = screen.getByTestId("chat");
    expect(chat.closest(".tr-chart-area")).not.toBeNull();
    expect(chat.closest(".tr-order-panel")).toBeNull();
  });

  it("unread counts while closed, clears on open; a DM doesn't count", async () => {
    mount();
    chatMessage("dm");
    expect(screen.queryByText("1")).toBeNull();
    chatMessage("match");
    expect(screen.getByText("1")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /CHAT/ }));
    expect(screen.queryByText("1")).toBeNull();
  });

  it("closing keeps the log mounted", async () => {
    mount();
    await userEvent.click(screen.getByRole("button", { name: /CHAT/ }));
    await userEvent.click(screen.getByRole("button", { name: /CHAT/ }));
    expect(screen.getByTestId("chat")).toHaveAttribute("data-open", "false");
  });

  it("a new match starts with chat closed and no unread", async () => {
    mount();
    await userEvent.click(screen.getByRole("button", { name: /CHAT/ }));
    act(() => useActiveMatchStore.getState().setActiveMatch({ ...MATCH, id: "m2" }));
    expect(screen.queryByTestId("chat")).toBeNull();
  });

  it("PRACTICE: header stays, banner shows", async () => {
    mount();
    await userEvent.click(screen.getByRole("radio", { name: "PRACTICE" }));
    expect(screen.getByRole("button", { name: "FORFEIT" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("Live match vs bob");
  });

  it("the match ending takes the header away", () => {
    mount();
    act(() => useActiveMatchStore.getState().setActiveMatch(null));
    expect(screen.queryByRole("button", { name: "FORFEIT" })).toBeNull();
  });
});
