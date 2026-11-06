import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const api = vi.hoisted(() => ({ forfeitMatch: vi.fn(), getActiveMatch: vi.fn(), getMatch: vi.fn() }));
vi.mock("@/api/endpoints/matches", () => api);

import { MatchHeaderBar } from "@/components/arena/MatchHeaderBar";
import ToastProvider from "@/components/ToastProvider";
import { useActiveMatchStore } from "@/stores/activeMatchStore";
import { useAuthStore } from "@/stores/authStore";
import type { Match } from "@/api/endpoints/matches";

const MATCH = {
  id: "m1", status: "ACTIVE", starting_capital: "100000.00000000", duration_hours: 24,
  challenger_id: "me", opponent_id: "opp", challenger_name: "alice", opponent_name: "bob",
  challenger_pnl_pct: "1.23456", opponent_pnl_pct: "-5",
  ends_at: new Date(Date.now() + 6 * 3_600_000).toISOString(),
} as unknown as Match;

function renderBar(match: Match = MATCH) {
  useActiveMatchStore.getState().setActiveMatch(match);
  render(
    <ToastProvider>
      <MatchHeaderBar match={match} chatOpen={false} chatUnread={0} onToggleChat={() => {}} />
    </ToastProvider>,
  );
}

beforeEach(() => {
  useAuthStore.setState({ user: { id: "me" } as never });
  useActiveMatchStore.getState().setActiveMatch(null);
  api.forfeitMatch.mockReset();
});

describe("MatchHeaderBar", () => {
  it("names, dollars and percent for both players", () => {
    renderBar();
    expect(screen.getByText("alice")).toBeTruthy();
    expect(screen.getByText("bob")).toBeTruthy();
    expect(screen.getByText("+$1,234.56 (+1.23%)")).toBeTruthy();
    expect(screen.getByText("-$5,000.00 (-5.00%)")).toBeTruthy();
  });

  it("you're on the left whichever side you are", () => {
    useAuthStore.setState({ user: { id: "opp" } as never });
    renderBar();
    const names = [...document.querySelectorAll(".mt-h-name")].map((e) => e.textContent);
    expect(names).toEqual(["bob", "alice"]);
  });

  it("a fee-sized loss is a real number: no -0.00%, no frozen $0.00", () => {
    renderBar({ ...MATCH, challenger_pnl_pct: "-0.0004", opponent_pnl_pct: "-0.0000004" } as Match);
    expect(screen.getByText("-$0.40 (-0.0004%)")).toBeTruthy();
    expect(screen.getByText("-$0.0004 (-<0.0001%)")).toBeTruthy();
    expect(document.body.textContent).not.toContain("-0.00%");
  });

  it("the live push wins over the read", () => {
    renderBar();
    act(() => useActiveMatchStore.setState({ livePnl: { matchId: "m1", challengerPnlPct: "2", opponentPnlPct: "0" } }));
    expect(screen.getByText("+$2,000.00 (+2.00%)")).toBeTruthy();
  });

  it("settling replaces the countdown", () => {
    renderBar({ ...MATCH, ends_at: new Date(Date.now() - 1_000).toISOString() } as Match);
    expect(screen.getByText("SETTLING…")).toBeTruthy();
    expect(screen.queryByText(/TIME LEFT/)).toBeNull();
  });

  it("FORFEIT asks first, then forfeits", async () => {
    api.forfeitMatch.mockResolvedValue({});
    api.getMatch.mockResolvedValue({ data: { match: { ...MATCH, status: "FORFEITED" } } });
    renderBar();
    await userEvent.click(screen.getByRole("button", { name: "FORFEIT" }));
    expect(api.forfeitMatch).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "CONFIRM FORFEIT" }));
    expect(api.forfeitMatch).toHaveBeenCalledWith("m1");
  });

  it("a refused forfeit is a toast", async () => {
    api.forfeitMatch.mockRejectedValue({ response: { data: { message: "Too late" } } });
    renderBar();
    await userEvent.click(screen.getByRole("button", { name: "FORFEIT" }));
    await userEvent.click(screen.getByRole("button", { name: "CONFIRM FORFEIT" }));
    expect(await screen.findByText("Too late")).toBeTruthy();
  });

  it("the timer goes urgent near the end, not for the whole of a short match", () => {
    const short = { ...MATCH, duration_hours: 0.25, ends_at: new Date(Date.now() + 14 * 60_000).toISOString() } as Match;
    renderBar(short);
    expect(document.querySelector(".mt-h-timer")!.className).not.toContain("urgent");
  });

  it("the last 10% is urgent", () => {
    const ending = { ...MATCH, duration_hours: 0.25, ends_at: new Date(Date.now() + 60_000).toISOString() } as Match;
    renderBar(ending);
    expect(document.querySelector(".mt-h-timer")!.className).toContain("urgent");
  });
});
