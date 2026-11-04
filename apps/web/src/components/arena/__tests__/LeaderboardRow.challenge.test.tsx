import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { LeaderboardRow, type LeaderboardRowEntry } from "@/components/arena/LeaderboardRow";

function Where() {
  const loc = useLocation();
  return <div data-testid="where">{loc.pathname + loc.search}</div>;
}

const entry = (over: Partial<LeaderboardRowEntry>): LeaderboardRowEntry => ({
  rank: 2, user_id: "u1", display_name: "top_trader", return_pct: "1", trades_count: 1, ...over,
});

function renderRow(e: LeaderboardRowEntry, isCurrentUser = false) {
  render(
    <MemoryRouter>
      <table><tbody><LeaderboardRow entry={e} isCurrentUser={isCurrentUser} rank={e.rank} /></tbody></table>
      <Where />
    </MemoryRouter>,
  );
}

describe("LeaderboardRow challenge", () => {
  it("⚔️ opens the challenge box pre-filled", () => {
    renderRow(entry({}));
    fireEvent.click(screen.getByRole("button", { name: "Challenge top_trader" }));
    expect(screen.getByTestId("where").textContent).toBe("/arena?challenge=top_trader");
  });

  it("links the name to the player's page", () => {
    renderRow(entry({}));
    expect(screen.getByRole("link", { name: "top_trader" })).toHaveAttribute("href", "/players/top_trader");
  });

  it("offers nothing on an Anonymous row", () => {
    renderRow(entry({ rank: 11, user_id: null, display_name: null }));
    expect(screen.getByText("Anonymous")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /challenge/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("offers nothing on your own row", () => {
    renderRow(entry({}), true);
    expect(screen.queryByRole("button", { name: /challenge/i })).not.toBeInTheDocument();
  });
});
