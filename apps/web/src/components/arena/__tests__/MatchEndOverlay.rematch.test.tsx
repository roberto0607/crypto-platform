import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";

vi.mock("@/api/client", () => ({ default: { get: vi.fn(() => Promise.reject(new Error("no result"))) } }));

import { MatchEndOverlay } from "@/components/arena/MatchEndOverlay";
import type { Match } from "@/api/endpoints/matches";

function Where() {
  const loc = useLocation();
  return <div data-testid="where">{loc.pathname + loc.search}</div>;
}

const MATCH = {
  id: "m1", status: "COMPLETED", challenger_id: "alice", opponent_id: "bob",
  challenger_name: "alice_t", opponent_name: "bob_t",
  challenger_pnl_pct: "1", opponent_pnl_pct: "-1", winner_id: "alice",
  challenger_elo: 800, opponent_elo: 800,
} as unknown as Match;

function renderOverlay(userId: string, onBackToArena = vi.fn(), match = MATCH) {
  render(
    <MemoryRouter>
      <MatchEndOverlay match={match} userId={userId} onBackToArena={onBackToArena} />
      <Where />
    </MemoryRouter>,
  );
  return onBackToArena;
}

describe("MatchEndOverlay rematch", () => {
  it.each([
    ["alice", "bob_t"],
    ["bob", "alice_t"],
  ])("as %s, REMATCH leaves the match and pre-fills %s", (userId, opponent) => {
    const onBack = renderOverlay(userId);
    fireEvent.click(screen.getByRole("button", { name: "REMATCH" }));
    expect(onBack).toHaveBeenCalled();
    expect(screen.getByTestId("where").textContent).toBe(`/arena?challenge=${opponent}`);
  });

  it("is hidden if the opponent's name is unknown", () => {
    renderOverlay("alice", vi.fn(), { ...MATCH, opponent_name: null } as Match);
    expect(screen.queryByRole("button", { name: "REMATCH" })).not.toBeInTheDocument();
  });
});
