import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const getLeaderboard = vi.hoisted(() => vi.fn());
vi.mock("@/api/endpoints/competitions", () => ({ getLeaderboard }));

import { SeasonLeaderboard } from "@/components/arena/SeasonLeaderboard";
import { useAuthStore } from "@/stores/authStore";

const row = (rank: number, user_id: string | null, display_name: string | null) => ({
  competition_id: "c1", rank, user_id, display_name,
  equity: "1000", return_pct: "1", max_drawdown_pct: "0", current_drawdown_pct: "0",
  trades_count: 1, updated_at: "2026-11-04T00:00:00Z",
});

describe("SeasonLeaderboard anonymous rows", () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    useAuthStore.setState({ user: { id: "me", email: "a@b.co", role: "USER" } });
    getLeaderboard.mockResolvedValue({
      data: {
        data: [
          row(1, "u1", "top_trader"),
          row(11, null, null),
          row(12, null, null),
          row(13, "me", "my_name"),
        ],
      },
    });
  });

  afterEach(() => consoleError.mockRestore());

  it("renders rows the API stripped of id and name, with no duplicate React keys", async () => {
    render(
      <MemoryRouter>
        <SeasonLeaderboard
          seasonInfo={{ id: "c1", name: "S1", end_at: "2099-01-01T00:00:00Z" }}
          seasonLoading={false}
          seasonError={false}
        />
      </MemoryRouter>,
    );
    expect(await screen.findByText("top_trader")).toBeInTheDocument();
    expect(screen.getAllByText("Anonymous")).toHaveLength(2);
    expect(screen.getByText("YOU")).toBeInTheDocument();
    const keyWarnings = consoleError.mock.calls.filter((call: unknown[]) => String(call[0]).includes("same key"));
    expect(keyWarnings).toEqual([]);
  });
});
