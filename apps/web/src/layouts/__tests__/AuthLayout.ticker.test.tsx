import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const fetchTickers = vi.fn();
vi.mock("@/api/endpoints/marketData", () => ({
  getPublicTickers: () => fetchTickers(),
}));

import AuthLayout from "@/layouts/AuthLayout";

function renderLayout() {
  return render(
    <MemoryRouter>
      <AuthLayout />
    </MemoryRouter>,
  );
}

describe("AuthLayout ticker (login/register page)", () => {
  beforeEach(() => { fetchTickers.mockClear(); });

  it("shows real BTC/ETH/SOL prices from the API and nothing else", async () => {
    fetchTickers.mockResolvedValue({
      data: {
        data: [
          { symbol: "BTC/USD", price: "61234.5", change24hPct: 1.5 },
          { symbol: "ETH/USD", price: "2400", change24hPct: -2 },
          { symbol: "SOL/USD", price: "150.25", change24hPct: 0.1 },
        ],
      },
    });
    renderLayout();

    await waitFor(() => expect(screen.getAllByText("$61,234.50").length).toBeGreaterThan(0));
    expect(screen.getAllByText("$2,400.00").length).toBeGreaterThan(0);
    expect(screen.getAllByText("$150.25").length).toBeGreaterThan(0);
    // The old hardcoded strip
    for (const fake of ["BNB", "AVAX", "DOGE", "ARB", "LINK", "$3,941.12"]) {
      expect(screen.queryByText(fake)).toBeNull();
    }
  });

  it("hides the strip entirely when prices can't be loaded — never shows fake ones", async () => {
    fetchTickers.mockImplementation(() => Promise.reject(new Error("offline")));
    renderLayout();
    await waitFor(() => expect(fetchTickers).toHaveBeenCalled());
    expect(screen.queryByText("LIVE")).toBeNull();
    expect(screen.queryByText("BTC")).toBeNull();
  });
});
