import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const getLeaderboard = vi.hoisted(() => vi.fn());
vi.mock("@/api/endpoints/competitions", () => ({ getLeaderboard }));

import { SeasonLeaderboard } from "@/components/arena/SeasonLeaderboard";
import { useAuthStore } from "@/stores/authStore";

const row = (rank: number, user_id: string | null, display_name: string | null) => ({
  competition_id: "c1", rank, user_id, display_name, nuanced_score: "42", win_rate: "75",
  equity: "0", return_pct: "1.5", max_drawdown_pct: "0", current_drawdown_pct: "0",
  trades_count: 4, updated_at: "2026-11-04T00:00:00Z",
});

const BOARD = Array.from({ length: 12 }, (_, i) => row(i + 1, i < 10 ? `u${i}` : null, i < 10 ? `player_${i}` : null));

function renderBoard(status: "ACTIVE" | "ENDED", end_at: string) {
  render(
    <MemoryRouter>
      <SeasonLeaderboard
        seasonInfo={{ id: "c1", name: "Season 3", end_at, season_number: 3, status }}
        seasonLoading={false}
        seasonError={false}
      />
    </MemoryRouter>,
  );
}

describe("SeasonLeaderboard", () => {
  beforeEach(() => {
    useAuthStore.setState({ user: { id: "me", email: "a@b.co", role: "USER" } });
    getLeaderboard.mockResolvedValue({ data: { data: BOARD } });
  });

  it("active: says how the board works, with MATCHES and a footer that matches reality", async () => {
    renderBoard("ACTIVE", "2099-01-01T00:00:00Z");
    await screen.findByText("player_0");
    expect(screen.getByText("MATCHES")).toBeInTheDocument();
    expect(screen.queryByText("TRADES")).not.toBeInTheDocument();
    expect(screen.getByText(/score = elo gained/i)).toBeInTheDocument();
    expect(screen.getByText(/first 3 matches vs each opponent/i)).toBeInTheDocument();
    expect(screen.getByText(/3\+ matches for a badge/i)).toBeInTheDocument();
    expect(screen.getByText(/ranks 11–12 stay anonymous/i)).toBeInTheDocument();
    expect(screen.queryByText(/revealed/i)).not.toBeInTheDocument();
  });

  it("off-season: final standings, with no countdown", async () => {
    renderBoard("ENDED", "2026-11-01T00:00:00Z");
    await screen.findByText("player_0");
    expect(screen.getByText(/season 3 final standings/i)).toBeInTheDocument();
    expect(screen.getByText(/off season/i)).toBeInTheDocument();
    expect(screen.queryByText(/rankings lock in/i)).not.toBeInTheDocument();
  });

  it("says nobody has played yet, rather than joined", async () => {
    getLeaderboard.mockResolvedValue({ data: { data: [] } });
    renderBoard("ACTIVE", "2099-01-01T00:00:00Z");
    expect(await screen.findByText(/no matches played in season 3 yet/i)).toBeInTheDocument();
  });
});
