import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";

const api = vi.hoisted(() => ({
  getActiveMatch: vi.fn(), getMatchHistory: vi.fn(), getActiveMatches: vi.fn(), acceptMatch: vi.fn(),
  forfeitMatch: vi.fn(), getMatch: vi.fn(), cancelActiveMatch: vi.fn(),
}));
vi.mock("@/api/endpoints/matches", () => api);
vi.mock("@/api/endpoints/competitions", () => ({
  getCurrentSeason: async () => ({ data: { season: null } }),
  getLeaderboard: async () => ({ data: { leaderboard: [] } }),
}));
vi.mock("@/components/arena/ChallengeBox", () => ({ ChallengeBox: () => null }));
vi.mock("@/components/arena/SeasonLeaderboard", () => ({ SeasonLeaderboard: () => null }));
vi.mock("@/components/ToastProvider", () => ({ useToast: () => ({ addToast: vi.fn() }) }));

import ArenaPage from "@/pages/ArenaPage";
import { useActiveMatchStore } from "@/stores/activeMatchStore";
import { useAuthStore } from "@/stores/authStore";
import type { Match } from "@/api/endpoints/matches";

const LIVE = {
  id: "m1", status: "ACTIVE", challenger_id: "me", opponent_id: "opp", challenger_name: "me_t", opponent_name: "bob_t",
  starting_capital: "100000", challenger_pnl_pct: "1.5", opponent_pnl_pct: "-2",
  ends_at: new Date(Date.now() + 3_600_000).toISOString(),
} as unknown as Match;
const PENDING = { ...LIVE, status: "PENDING", challenger_id: "opp", opponent_id: "me", ends_at: null } as Match;

function Where() {
  const l = useLocation();
  return <div data-testid="where">{l.pathname}</div>;
}
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
async function mount() {
  render(<MemoryRouter initialEntries={["/arena"]}><ArenaPage /><Where /></MemoryRouter>);
  await flush();
}
const where = () => screen.getByTestId("where").textContent;

beforeEach(() => {
  useAuthStore.setState({ user: { id: "me" } as never });
  useActiveMatchStore.getState().setActiveMatch(null);
  api.getActiveMatch.mockReset().mockResolvedValue({ data: { match: LIVE } });
  api.getMatchHistory.mockResolvedValue({ data: { matches: [], total: 0 } });
  api.acceptMatch.mockReset().mockResolvedValue({});
});

describe("Arena during a live match", () => {
  it("shows the lobby with a MATCH LIVE card: no forced redirect", async () => {
    await mount();
    expect(where()).toBe("/arena");
    expect(screen.getByText("TRADE WARS")).toBeTruthy();
    expect(screen.getByText("MATCH LIVE")).toBeTruthy();
  });

  it("the card shows dollars and percent, live", async () => {
    await mount();
    expect(screen.getByText("+$1,500.00 (+1.50%)")).toBeTruthy();
    act(() => useActiveMatchStore.setState({ activeMatch: LIVE, livePnl: { matchId: "m1", challengerPnlPct: "3", opponentPnlPct: "0" } }));
    expect(screen.getByText("+$3,000.00 (+3.00%)")).toBeTruthy();
  });

  it("ENTER MATCH goes to /trade", async () => {
    await mount();
    await userEvent.click(screen.getByRole("button", { name: "ENTER MATCH" }));
    expect(where()).toBe("/trade");
  });

  it("forfeiting lives on the match screen, not here", async () => {
    await mount();
    expect(screen.queryByRole("button", { name: "FORFEIT" })).toBeNull();
  });
});

describe("a match starting while on the Arena", () => {
  it("match.started takes the player to /trade", async () => {
    api.getActiveMatch.mockResolvedValue({ data: { match: null } });
    await mount();
    api.getActiveMatch.mockResolvedValue({ data: { match: LIVE } });
    await act(async () => { window.dispatchEvent(new CustomEvent("sse:match.started")); });
    await flush();
    expect(where()).toBe("/trade");
  });

  it("a pending challenge is left to the global card: the Arena doesn't show it twice", async () => {
    api.getActiveMatch.mockResolvedValue({ data: { match: PENDING } });
    await mount();
    expect(screen.queryByRole("button", { name: "ACCEPT" })).toBeNull();
    expect(screen.queryByText(/challenged you/i)).toBeNull();
  });

  it("reads the shared store: a challenge closed elsewhere is gone here too", async () => {
    api.getActiveMatch.mockResolvedValue({ data: { match: null } });
    await mount();
    act(() => useActiveMatchStore.getState().setActiveMatch(LIVE));
    expect(screen.getByText("MATCH LIVE")).toBeTruthy();
    act(() => useActiveMatchStore.getState().setActiveMatch(null));
    expect(screen.queryByText("MATCH LIVE")).toBeNull();
  });
});
