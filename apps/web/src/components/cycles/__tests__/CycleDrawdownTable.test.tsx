import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import CycleDrawdownTable from "@/components/cycles/CycleDrawdownTable";
import { BTC_CYCLES } from "@/lib/btcCycles";

describe("CycleDrawdownTable", () => {
  it("renders the four historical cycles plus a live NOW row", () => {
    render(<CycleDrawdownTable currentPrice={65_000} />);
    const rows = screen.getAllByRole("row");
    // header + 4 cycles + NOW
    expect(rows).toHaveLength(1 + BTC_CYCLES.length + 1);
    expect(screen.getByText("NOW")).toBeInTheDocument();
  });

  it("shows each cycle's drawdown percentage", () => {
    render(<CycleDrawdownTable currentPrice={65_000} />);
    for (const c of BTC_CYCLES) {
      expect(screen.getByText(`${c.drawdownPct}%`)).toBeInTheDocument();
    }
  });

  it("renders an em-dash for the live drawdown when no price is available", () => {
    render(<CycleDrawdownTable currentPrice={undefined} />);
    const nowRow = screen.getByText("NOW").closest("tr")!;
    // bottom cell + live drawdown cell both em-dash without a price
    expect(within(nowRow).getAllByText("—").length).toBeGreaterThanOrEqual(2);
  });
});
