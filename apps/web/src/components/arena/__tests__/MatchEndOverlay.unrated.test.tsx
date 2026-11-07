import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const RESULT = {
  match_id: "m1", winner_id: "alice", loser_id: "bob",
  winner_old_elo: 800, winner_new_elo: 800, winner_delta: 0,
  loser_old_elo: 800, loser_new_elo: 797, loser_delta: -3,
  winner_tier_before: "ROOKIE", winner_tier_after: "ROOKIE",
  loser_tier_before: "ROOKIE", loser_tier_after: "ROOKIE",
  winner_win_streak: 0, streak_multiplier: "1", badges_earned: [],
  winner_unrated_reason: "EARLY_FORFEIT",
};
vi.mock("@/api/client", () => ({ default: { get: vi.fn(() => Promise.resolve({ data: { ok: true, result: RESULT } })) } }));

import { MatchEndOverlay } from "@/components/arena/MatchEndOverlay";
import type { Match } from "@/api/endpoints/matches";

const MATCH = {
  id: "m1", status: "FORFEITED", challenger_id: "alice", opponent_id: "bob",
  challenger_name: "alice_t", opponent_name: "bob_t", forfeit_user_id: "bob",
  challenger_pnl_pct: "0", opponent_pnl_pct: "0", winner_id: "alice",
  challenger_elo: 800, opponent_elo: 800,
} as unknown as Match;

const show = (userId: string) =>
  render(
    <MemoryRouter>
      <MatchEndOverlay match={MATCH} userId={userId} onBackToArena={() => {}} onViewBreakdown={() => {}} />
    </MemoryRouter>,
  );

describe("MatchEndOverlay unrated win", () => {
  it("shows UNRATED to the winner", async () => {
    show("alice");
    expect(await screen.findByText("UNRATED")).toBeInTheDocument();
  });

  it("shows the loss to the loser", async () => {
    show("bob");
    // The delta counts up over 800ms.
    expect(await screen.findByText("-3", {}, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.queryByText("UNRATED")).not.toBeInTheDocument();
  });
});
