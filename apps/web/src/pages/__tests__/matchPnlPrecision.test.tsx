/**
 * Two players' match P&L, side by side, never look tied when they differ and
 * never mix precisions. Prod: -$10.26 vs -$9.78 on $50,000 both read
 * "-0.02%", and the end overlay showed "-0.0084%" next to "-0.02%". The match
 * header, the end overlay, match history and the breakdown all show both at
 * one precision (lib/matchPnl formatPnlPctPair), with dollars where there's room.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, act } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

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
vi.mock("@/api/client", async (orig) => ({
  ...(await orig<object>()),
  default: { get: vi.fn(() => Promise.reject(new Error("no result"))) },
}));
const breakdown = vi.hoisted(() => ({ getMatchBreakdown: vi.fn() }));
vi.mock("@/api/endpoints/matchBreakdown", () => breakdown);

import ArenaPage from "@/pages/ArenaPage";
import MatchBreakdownPage from "@/pages/MatchBreakdownPage";
import { MatchEndOverlay } from "@/components/arena/MatchEndOverlay";
import { MatchHeaderBar } from "@/components/arena/MatchHeaderBar";
import ToastProvider from "@/components/ToastProvider";
import { useActiveMatchStore } from "@/stores/activeMatchStore";
import { useAuthStore } from "@/stores/authStore";
import type { Match } from "@/api/endpoints/matches";

// roberto vs berto: -$10.26 vs -$9.78 on $50,000.
const ENDED = {
  id: "m1", status: "COMPLETED", starting_capital: "50000.00000000", duration_hours: 1,
  challenger_id: "me", opponent_id: "opp", challenger_name: "roberto", opponent_name: "berto",
  challenger_pnl_pct: "-0.02052000", opponent_pnl_pct: "-0.01956000", winner_id: "opp",
  completed_at: "2026-11-07T20:00:00Z", challenger_elo: 1200, opponent_elo: 1200,
} as unknown as Match;

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const tied = (a: string | null | undefined, b: string | null | undefined) => {
  expect(a).toBeTruthy();
  expect(a).not.toBe(b);
};

beforeEach(() => {
  useAuthStore.setState({ user: { id: "me" } as never });
  useActiveMatchStore.getState().setActiveMatch(null);
  api.getActiveMatch.mockReset().mockResolvedValue({ data: { match: null } });
  api.getMatchHistory.mockReset().mockResolvedValue({ data: { matches: [], total: 0 } });
});

describe("match P&L precision", () => {
  it("end overlay: both players with dollars, at one precision", async () => {
    render(
      <MemoryRouter>
        <MatchEndOverlay match={ENDED} userId="me" onBackToArena={() => {}} onViewBreakdown={() => {}} />
      </MemoryRouter>,
    );
    await flush();
    expect(screen.getByText("-$10.26 (-0.021%)")).toBeInTheDocument();
    expect(screen.getByText("-$9.78 (-0.020%)")).toBeInTheDocument();
  });

  it("end overlay: no mixing four decimals with two", async () => {
    render(
      <MemoryRouter>
        <MatchEndOverlay
          match={{ ...ENDED, challenger_pnl_pct: "-0.0084", opponent_pnl_pct: "-0.02" } as Match}
          userId="me" onBackToArena={() => {}} onViewBreakdown={() => {}}
        />
      </MemoryRouter>,
    );
    await flush();
    expect(screen.getByText("-$4.20 (-0.0084%)")).toBeInTheDocument();
    expect(screen.getByText("-$10.00 (-0.0200%)")).toBeInTheDocument();
  });

  it("match header: both players at one precision", () => {
    const live = { ...ENDED, status: "ACTIVE", winner_id: null, ends_at: new Date(Date.now() + 3_600_000).toISOString() } as unknown as Match;
    useActiveMatchStore.getState().setActiveMatch(live);
    render(
      <ToastProvider>
        <MatchHeaderBar match={live} chatOpen={false} chatUnread={0} onToggleChat={() => {}} />
      </ToastProvider>,
    );
    const pnls = [...document.querySelectorAll(".mt-h-pnl")].map((e) => e.textContent);
    expect(pnls).toEqual(["-$10.26 (-0.021%)", "-$9.78 (-0.020%)"]);
  });

  it("match history: the two columns never read the same", async () => {
    api.getMatchHistory.mockResolvedValue({ data: { matches: [ENDED], total: 1 } });
    render(<MemoryRouter initialEntries={["/arena"]}><ArenaPage /></MemoryRouter>);
    await flush();
    const row = screen.getByText("berto").closest("tr")!;
    const cells = [...row.querySelectorAll("td")].map((td) => td.textContent);
    expect(cells[2]).toBe("-0.021%");
    expect(cells[3]).toBe("-0.020%");
    tied(cells[2], cells[3]);
  });

  it("breakdown: both summaries at one precision", async () => {
    breakdown.getMatchBreakdown.mockResolvedValue({
      data: {
        ok: true,
        match: { id: "m1", status: "COMPLETED", endedAt: "2026-11-07T20:00:00Z", challenger: { id: "me", name: "roberto" }, opponent: { id: "opp", name: "berto" } },
        challengerOrders: [], opponentOrders: [],
        challengerSummary: { pnlPct: "-0.0084", realizedPnlQuote: "0", feesQuote: "4.2", netPnlQuote: "-4.2" },
        opponentSummary: { pnlPct: "-0.02", realizedPnlQuote: "-5", feesQuote: "5", netPnlQuote: "-10" },
      },
    });
    render(
      <MemoryRouter initialEntries={["/matches/m1/breakdown"]}>
        <Routes><Route path="/matches/:id/breakdown" element={<MatchBreakdownPage />} /></Routes>
      </MemoryRouter>,
    );
    const mine = within(await screen.findByTestId("breakdown-summary-challenger"));
    const theirs = within(screen.getByTestId("breakdown-summary-opponent"));
    expect(mine.getByText("-0.0084%")).toBeInTheDocument();
    expect(theirs.getByText("-0.0200%")).toBeInTheDocument();
  });
});
