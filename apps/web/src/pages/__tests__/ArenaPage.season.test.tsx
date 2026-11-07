import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
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

  describe("the banner", () => {
    const SEASON = {
      id: "s1", name: "Season 1", season_number: 1, status: "ACTIVE",
      start_at: "2026-11-01T00:00:00Z", end_at: "2099-01-01T00:00:00Z",
    };
    const entry = (nuanced_score: string, return_pct: string) => ({
      user_id: "me", rank: 1, display_name: "me_t", return_pct, nuanced_score, trades_count: 2, win_rate: "0",
    });
    const banner = async (label: string) => {
      const lbl = (await screen.findAllByText(label, { selector: ".ar-sc-lbl" }))[0]!;
      return lbl.previousElementSibling as HTMLElement;
    };
    async function show(score: string, ret: string) {
      api.getCurrentSeason.mockResolvedValue({ data: { season: SEASON } });
      api.getLeaderboard.mockResolvedValue({ data: { leaderboard: [entry(score, ret)] } });
      openSeasonTab();
      await screen.findByText(score === "33" ? "33" : /^-?\d+$/, { selector: ".ar-sc-val" });
    }

    it("negative SCORE and RETURN are red", async () => {
      await show("-6", "-0.0017");
      expect((await banner("SCORE")).className).toContain("red");
      expect((await banner("RETURN")).className).toContain("red");
    });

    it("positive SCORE and RETURN are green", async () => {
      await show("33", "0.25");
      expect((await banner("SCORE")).className).toContain("green");
      expect((await banner("RETURN")).className).toContain("green");
    });

    it("zero is neither", async () => {
      await show("0", "0");
      for (const label of ["SCORE", "RETURN"]) {
        const cls = (await banner(label)).className;
        expect(cls).not.toContain("red");
        expect(cls).not.toContain("green");
      }
    });

    it("is the only stats block: the season tab doesn't repeat it", async () => {
      await show("33", "0.25");
      expect(screen.queryByText("YOUR SCORE")).toBeNull();
      expect(screen.queryByText("YOUR P&L", { selector: ".slb-stat-lbl" })).toBeNull();
      expect(screen.queryByText("SEASON ENDS")).toBeNull();
    });

    it("stays current: the board's 60 s refresh reaches it", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        await show("33", "0.25");
        api.getLeaderboard.mockResolvedValue({ data: { leaderboard: [entry("48", "0.5")] } });
        await act(async () => { await vi.advanceTimersByTimeAsync(61_000); });
        expect(screen.getByText("48", { selector: ".ar-sc-val" })).toBeInTheDocument();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
