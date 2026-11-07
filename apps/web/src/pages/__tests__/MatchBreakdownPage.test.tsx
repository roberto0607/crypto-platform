import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

const api = vi.hoisted(() => ({ getMatchBreakdown: vi.fn() }));
vi.mock("@/api/endpoints/matchBreakdown", () => api);

import MatchBreakdownPage from "@/pages/MatchBreakdownPage";

const ORDER = {
  orderId: "o1", pairSymbol: "BTC/USD", side: "BUY", type: "MARKET", qty: "0.01", qtyFilled: "0.01",
  avgFillPrice: "70000", status: "FILLED", placedAt: "2026-11-06T12:00:00Z", lastFillAt: "2026-11-06T12:00:00Z",
};
const BREAKDOWN = {
  ok: true,
  match: {
    id: "m1", status: "COMPLETED", endedAt: "2026-11-06T13:00:00Z",
    challenger: { id: "a", name: "roberto" }, opponent: { id: "b", name: "rival" },
  },
  challengerOrders: [ORDER],
  opponentOrders: [],
  challengerSummary: { pnlPct: "0.19", realizedPnlQuote: "100.00000000", feesQuote: "5.00000000", netPnlQuote: "95.00000000" },
  opponentSummary: { pnlPct: "-0.01", realizedPnlQuote: "0.00000000", feesQuote: "5.25000000", netPnlQuote: "-5.25000000" },
};

function mount() {
  render(
    <MemoryRouter initialEntries={["/matches/m1/breakdown"]}>
      <Routes><Route path="/matches/:id/breakdown" element={<MatchBreakdownPage />} /></Routes>
    </MemoryRouter>,
  );
}

describe("MatchBreakdownPage", () => {
  beforeEach(() => {
    api.getMatchBreakdown.mockResolvedValue({ data: BREAKDOWN });
  });

  it("shows each player's P&L, fees and net beside their orders", async () => {
    mount();
    const mine = within((await screen.findByTestId("breakdown-summary-challenger")));
    expect(mine.getByText("+0.19%")).toBeInTheDocument();
    expect(mine.getByText("+$100.00")).toBeInTheDocument();
    expect(mine.getByText("$5.00")).toBeInTheDocument();
    expect(mine.getByText("+$95.00")).toBeInTheDocument();

    const theirs = within(screen.getByTestId("breakdown-summary-opponent"));
    expect(theirs.getByText("-0.01%")).toBeInTheDocument();
    expect(theirs.getByText("$5.25")).toBeInTheDocument();
    expect(theirs.getByText("-$5.25")).toBeInTheDocument();

    expect(screen.getByText("BTC/USD")).toBeInTheDocument();
    expect(screen.getByText("NO TRADES")).toBeInTheDocument();
  });
});
