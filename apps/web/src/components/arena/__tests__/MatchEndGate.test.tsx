import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";

vi.mock("@/api/client", async (orig) => ({
  ...(await orig<typeof import("@/api/client")>()),
  default: { get: vi.fn(() => Promise.reject(new Error("no result"))) },
}));

import { MatchEndGate } from "@/components/arena/MatchEndGate";
import { useActiveMatchStore } from "@/stores/activeMatchStore";
import { useAuthStore } from "@/stores/authStore";
import type { Match } from "@/api/endpoints/matches";

const ENDED = {
  id: "m1", status: "COMPLETED", challenger_id: "me", opponent_id: "opp", challenger_name: "me_t", opponent_name: "bob_t",
  challenger_pnl_pct: "1", opponent_pnl_pct: "-1", winner_id: "me", challenger_elo: 800, opponent_elo: 800,
} as unknown as Match;

function Where() {
  const l = useLocation();
  return <div data-testid="where">{l.pathname + l.search}</div>;
}
const mount = (at: string) => render(<MemoryRouter initialEntries={[at]}><MatchEndGate /><Where /></MemoryRouter>);
const where = () => screen.getByTestId("where").textContent;

beforeEach(() => {
  useAuthStore.setState({ user: { id: "me" } as never });
  useActiveMatchStore.getState().setActiveMatch(null);
});

describe("MatchEndGate: the result appears wherever the player is", () => {
  it.each(["/trade", "/history", "/profile"])("on %s", (at) => {
    mount(at);
    expect(screen.queryByText("BACK TO ARENA")).toBeNull();
    act(() => useActiveMatchStore.setState({ endedMatch: ENDED }));
    expect(screen.getByText("BACK TO ARENA")).toBeTruthy();
  });

  it("BACK TO ARENA clears it and goes to the arena", async () => {
    useActiveMatchStore.setState({ endedMatch: ENDED });
    mount("/trade");
    await userEvent.click(screen.getByText("BACK TO ARENA"));
    expect(where()).toBe("/arena");
    expect(useActiveMatchStore.getState().endedMatch).toBeNull();
  });

  it("VIEW TRADE BREAKDOWN clears it and opens the breakdown", async () => {
    useActiveMatchStore.setState({ endedMatch: ENDED });
    mount("/trade");
    await userEvent.click(screen.getByText("VIEW TRADE BREAKDOWN"));
    expect(where()).toBe("/matches/m1/breakdown");
    expect(useActiveMatchStore.getState().endedMatch).toBeNull();
    expect(screen.queryByText("VIEW TRADE BREAKDOWN")).toBeNull();
  });

  it("REMATCH lands on the challenge box, pre-filled", async () => {
    useActiveMatchStore.setState({ endedMatch: ENDED });
    mount("/trade");
    await userEvent.click(screen.getByText("REMATCH"));
    expect(where()).toBe("/arena?challenge=bob_t");
    expect(useActiveMatchStore.getState().endedMatch).toBeNull();
  });
});
