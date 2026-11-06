import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MatchScopeSwitch } from "@/components/trading/MatchScopeSwitch";
import { useActiveMatchStore } from "@/stores/activeMatchStore";
import { useAuthStore } from "@/stores/authStore";
import { orderScope } from "@/lib/orderScope";
import type { Match } from "@/api/endpoints/matches";

const MATCH = { id: "m1", status: "ACTIVE", challenger_id: "me", opponent_id: "opp", opponent_name: "bob", challenger_name: "me_t" } as Match;
const store = () => useActiveMatchStore.getState();

beforeEach(() => {
  useAuthStore.setState({ user: { id: "me" } as never });
  store().setActiveMatch(null);
});

describe("MATCH | PRACTICE", () => {
  it("not in a match: nothing to switch", () => {
    const { container } = render(<MatchScopeSwitch />);
    expect(container.textContent).toBe("");
    expect(orderScope()).toBe("free");
  });

  it("a live match defaults to MATCH", () => {
    store().setActiveMatch(MATCH);
    render(<MatchScopeSwitch />);
    expect(screen.getByRole("radio", { name: "MATCH" })).toBeChecked();
    expect(orderScope()).toBe("m1");
    expect(screen.queryByText(/switch back/i)).toBeNull();
  });

  it("PRACTICE: free-play scope, and a banner back to the match", async () => {
    store().setActiveMatch(MATCH);
    render(<MatchScopeSwitch />);
    await userEvent.click(screen.getByRole("radio", { name: "PRACTICE" }));
    expect(orderScope()).toBe("free");
    expect(screen.getByRole("status").textContent).toContain("Live match vs bob");
    await userEvent.click(screen.getByRole("button", { name: /switch back/i }));
    expect(orderScope()).toBe("m1");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("names the opponent whichever side you're on", async () => {
    useAuthStore.setState({ user: { id: "opp" } as never });
    store().setActiveMatch(MATCH);
    store().setTradeMode("PRACTICE");
    render(<MatchScopeSwitch />);
    expect(screen.getByRole("status").textContent).toContain("Live match vs me_t");
  });

  it("the match ending takes the switch away", () => {
    store().setActiveMatch(MATCH);
    const { container, rerender } = render(<MatchScopeSwitch />);
    store().setActiveMatch(null);
    rerender(<MatchScopeSwitch />);
    expect(container.textContent).toBe("");
  });
});
