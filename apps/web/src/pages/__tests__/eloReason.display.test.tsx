/**
 * The end overlay and match history say why an ELO change was unrated or
 * scaled, in plain words, and a zero change reads "0", never "-0".
 */
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
const result = vi.hoisted(() => ({ value: null as null | Record<string, unknown> }));
vi.mock("@/api/client", async (orig) => ({
  ...(await orig<object>()),
  default: { get: vi.fn(() => Promise.resolve({ data: { ok: true, result: result.value } })) },
}));

import ArenaPage from "@/pages/ArenaPage";
import { MatchEndOverlay } from "@/components/arena/MatchEndOverlay";
import { useActiveMatchStore } from "@/stores/activeMatchStore";
import { useAuthStore } from "@/stores/authStore";
import type { Match } from "@/api/endpoints/matches";

const MATCH = {
  id: "m1", status: "COMPLETED", starting_capital: "50000", duration_hours: 1,
  challenger_id: "me", opponent_id: "opp", challenger_name: "roberto", opponent_name: "berto",
  challenger_pnl_pct: "-0.02", opponent_pnl_pct: "0.01", winner_id: "opp",
  completed_at: "2026-11-07T20:00:00Z", challenger_elo: 800, opponent_elo: 800,
} as unknown as Match;

const RESULT = {
  match_id: "m1", winner_id: "opp", loser_id: "me",
  winner_old_elo: 800, winner_new_elo: 800, winner_delta: 0,
  loser_old_elo: 800, loser_new_elo: 800, loser_delta: 0,
  winner_tier_before: "ROOKIE", winner_tier_after: "ROOKIE", loser_tier_before: "ROOKIE", loser_tier_after: "ROOKIE",
  winner_win_streak: 2, streak_multiplier: "1", badges_earned: [],
  winner_unrated_reason: "REPEAT_OPPONENT", pair_match_number: 3, winner_qualified: true, loser_qualified: true,
};

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const overlay = async (userId: string) => {
  render(
    <MemoryRouter>
      <MatchEndOverlay match={MATCH} userId={userId} onBackToArena={() => {}} onViewBreakdown={() => {}} />
    </MemoryRouter>,
  );
  await flush();
};

beforeEach(() => {
  useAuthStore.setState({ user: { id: "me" } as never });
  useActiveMatchStore.getState().setActiveMatch(null);
  api.getActiveMatch.mockReset().mockResolvedValue({ data: { match: null } });
  api.getMatchHistory.mockReset().mockResolvedValue({ data: { matches: [], total: 0 } });
  result.value = RESULT;
});

describe("end overlay", () => {
  it("a zero loss reads 0, not -0, with the reason", async () => {
    await overlay("me");
    expect(screen.queryByText("-0")).toBeNull();
    expect(screen.getByTestId("elo-change").textContent).toBe("0");
    expect(screen.getByTestId("elo-reason").textContent).toBe("Repeat opponent — 3rd match in 24h");
  });

  it("an unrated win says why", async () => {
    result.value = { ...RESULT, winner_unrated_reason: "NOT_QUALIFIED", pair_match_number: 1, loser_qualified: false, loser_delta: -3 };
    await overlay("opp");
    expect(screen.getByTestId("elo-change").textContent).toBe("UNRATED");
    expect(screen.getByTestId("elo-reason").textContent).toBe("Opponent didn't trade enough");
  });

  it("a 50% change says so", async () => {
    result.value = { ...RESULT, winner_unrated_reason: null, pair_match_number: 2, winner_delta: 8, winner_new_elo: 808, loser_delta: -2, loser_new_elo: 798 };
    await overlay("me");
    expect(screen.getByTestId("elo-reason").textContent).toBe("50% — 2nd match vs this opponent today");
  });

  it("a full-value change has no reason line", async () => {
    result.value = { ...RESULT, winner_unrated_reason: null, pair_match_number: 1, winner_delta: 15, loser_delta: -3 };
    await overlay("me");
    expect(screen.queryByTestId("elo-reason")).toBeNull();
  });
});

describe("match history", () => {
  async function historyRow(m: Record<string, unknown>) {
    api.getMatchHistory.mockResolvedValue({ data: { matches: [{ ...MATCH, ...m }], total: 1 } });
    render(<MemoryRouter initialEntries={["/arena"]}><ArenaPage /></MemoryRouter>);
    await flush();
    return screen.getByText("berto").closest("tr")!;
  }

  it("a scaled-to-zero loss: 0 and the reason", async () => {
    const row = await historyRow({ loser_elo_delta: 0, winner_elo_delta: 0, winner_unrated_reason: "REPEAT_OPPONENT", pair_match_number: 3 });
    expect(row.querySelector("[data-testid='history-elo']")!.textContent).toBe("0");
    expect(row.querySelector("[data-testid='history-elo-reason']")!.textContent).toBe("Repeat opponent — 3rd match in 24h");
  });

  it("an unrated win: UNRATED and why", async () => {
    const row = await historyRow({ winner_id: "me", winner_elo_delta: 0, loser_elo_delta: -3, winner_unrated_reason: "EARLY_FORFEIT", pair_match_number: 1 });
    expect(row.querySelector("[data-testid='history-elo']")!.textContent).toBe("UNRATED");
    expect(row.querySelector("[data-testid='history-elo-reason']")!.textContent).toBe("Early forfeit");
  });

  it("a full-value result has no reason", async () => {
    const row = await historyRow({ loser_elo_delta: -3, winner_elo_delta: 15, winner_unrated_reason: null, pair_match_number: 1 });
    expect(row.querySelector("[data-testid='history-elo']")!.textContent).toBe("-3");
    expect(row.querySelector("[data-testid='history-elo-reason']")).toBeNull();
  });
});
