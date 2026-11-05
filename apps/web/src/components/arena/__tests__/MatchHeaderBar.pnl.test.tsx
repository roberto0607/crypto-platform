import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MatchHeaderBar } from "@/components/arena/MatchHeaderBar";
import type { Match } from "@/api/endpoints/matches";

const MATCH = { id: "m1", starting_capital: "100000.00000000", ends_at: null } as unknown as Match;

function renderBar(yourPnl: string | null, opponentPnl: string | null) {
  render(
    <MatchHeaderBar
      match={MATCH} yourPnl={yourPnl} opponentPnl={opponentPnl} yourName="alice" opponentName="bob"
      onForfeit={() => {}} chatOpen={false} chatUnread={0} onToggleChat={() => {}}
    />,
  );
}

describe("MatchHeaderBar P&L", () => {
  it("shows dollars and percent for both players", () => {
    renderBar("1.23456", "-5");
    expect(screen.getByText("+$1,234.56 (+1.23%)")).toBeTruthy();
    expect(screen.getByText("-$5,000.00 (-5.00%)")).toBeTruthy();
  });

  it("a fee-sized loss is a real number, not -0.00%", () => {
    renderBar("-0.0005", "0");
    expect(screen.getByText("-$0.50 (-0.0005%)")).toBeTruthy();
    expect(screen.getByText("$0.00 (0.00%)")).toBeTruthy();
    expect(document.body.textContent).not.toContain("-0.00%");
  });
});
