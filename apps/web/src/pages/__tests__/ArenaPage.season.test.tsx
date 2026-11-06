import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const api = vi.hoisted(() => ({ getCurrentSeason: vi.fn(), getLeaderboard: vi.fn() }));
vi.mock("@/api/endpoints/competitions", () => api);
vi.mock("@/api/endpoints/matches", () => ({
  getActiveMatch: vi.fn(() => Promise.resolve({ data: { match: null } })),
  getMatchHistory: vi.fn(() => Promise.resolve({ data: { matches: [], total: 0 } })),
  getActiveMatches: vi.fn(() => Promise.resolve({ data: { matches: [] } })),
}));
vi.mock("@/components/arena/ChallengeBox", () => ({ ChallengeBox: () => null }));
vi.mock("@/components/ToastProvider", () => ({ useToast: () => ({ addToast: vi.fn() }) }));

import ArenaPage from "@/pages/ArenaPage";
import { useAuthStore } from "@/stores/authStore";

function openSeasonTab() {
  render(<MemoryRouter><ArenaPage /></MemoryRouter>);
  fireEvent.click(screen.getByText("SEASON", { selector: ".ar-tab" }));
}

describe("ArenaPage season", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuthStore.setState({ user: { id: "me", email: "a@b.co", role: "USER" } });
    api.getLeaderboard.mockResolvedValue({ data: { data: [] } });
  });

  it("shows NO ACTIVE SEASON when there is none", async () => {
    api.getCurrentSeason.mockResolvedValue({ data: { season: null } });
    openSeasonTab();
    expect(await screen.findByText("NO ACTIVE SEASON")).toBeInTheDocument();
    expect(api.getLeaderboard).not.toHaveBeenCalled();
  });

  it("shows whichever season the API picks, ended ones included", async () => {
    api.getCurrentSeason.mockResolvedValue({
      data: {
        season: {
          id: "s1", name: "Season 2", season_number: 2, status: "ENDED",
          start_at: "2026-10-01T00:00:00Z", end_at: "2026-10-29T00:00:00Z",
        },
      },
    });
    openSeasonTab();
    expect(await screen.findByText(/season 2 final standings/i)).toBeInTheDocument();
  });
});
