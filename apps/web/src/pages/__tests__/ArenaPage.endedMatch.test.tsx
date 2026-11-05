import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

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
vi.mock("@/components/arena/LiveMatchView", () => ({
  LiveMatchView: (p: { match: { id: string } }) => <div data-testid="lmv">{p.match.id}</div>,
}));
vi.mock("@/components/ToastProvider", () => ({ useToast: () => ({ addToast: vi.fn() }) }));

import ArenaPage from "@/pages/ArenaPage";
import { useActiveMatchStore } from "@/stores/activeMatchStore";
import type { Match } from "@/api/endpoints/matches";

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

beforeEach(() => {
  api.getActiveMatch.mockResolvedValue({ data: { match: null } });
  api.getMatchHistory.mockResolvedValue({ data: { matches: [], total: 0 } });
  useActiveMatchStore.getState().setActiveMatch(null);
});

describe("ArenaPage and a finished match", () => {
  it("keeps the result on screen when its own reload finds no active match", async () => {
    useActiveMatchStore.setState({ endedMatch: { id: "m1", status: "COMPLETED" } as Match });
    render(<MemoryRouter><ArenaPage /></MemoryRouter>);
    await flush();
    expect(screen.getByTestId("lmv").textContent).toBe("m1");
  });

  it("no result: the lobby", async () => {
    render(<MemoryRouter><ArenaPage /></MemoryRouter>);
    await flush();
    expect(screen.queryByTestId("lmv")).toBeNull();
    expect(screen.getByText("TRADE WARS")).toBeTruthy();
  });
});
