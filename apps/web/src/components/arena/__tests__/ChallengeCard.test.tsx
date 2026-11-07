/**
 * The receiver card: a pending 1v1 shows on every page, from the shared store.
 * The receiver gets ACCEPT / DECLINE, the sender WAITING FOR + WITHDRAW.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";

const api = vi.hoisted(() => ({
  getActiveMatch: vi.fn(), getMatch: vi.fn(), forfeitMatch: vi.fn(),
  acceptMatch: vi.fn(), cancelActiveMatch: vi.fn(),
}));
vi.mock("@/api/endpoints/matches", () => api);
const addToast = vi.hoisted(() => vi.fn());
vi.mock("@/components/ToastProvider", () => ({ useToast: () => ({ addToast }) }));

import { ChallengeCard } from "@/components/arena/ChallengeCard";
import { useActiveMatchStore } from "@/stores/activeMatchStore";
import { useAuthStore } from "@/stores/authStore";
import type { Match } from "@/api/endpoints/matches";

const PENDING = {
  id: "m1", status: "PENDING", challenger_id: "alice", opponent_id: "bob",
  challenger_name: "alice_t", opponent_name: "bob_t", duration_hours: 1, starting_capital: "50000.00000000",
  ends_at: null,
} as unknown as Match;
const LIVE = { ...PENDING, status: "ACTIVE", ends_at: new Date(Date.now() + 3_600_000).toISOString() } as Match;

const active = (m: Match | null) => ({ data: { ok: true, match: m } });
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 150)); });
const fire = (type: string, detail?: unknown) => act(() => { window.dispatchEvent(new CustomEvent(type, { detail })); });

function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>;
}
async function mount(as: string, at = "/profile") {
  useAuthStore.setState({ user: { id: as } as never });
  render(<MemoryRouter initialEntries={[at]}><ChallengeCard /><Where /></MemoryRouter>);
  await flush();
}
const where = () => screen.getByTestId("where").textContent;

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  useActiveMatchStore.getState().setActiveMatch(null);
  api.getActiveMatch.mockResolvedValue(active(PENDING));
  api.acceptMatch.mockResolvedValue({ data: { ok: true } });
  api.cancelActiveMatch.mockResolvedValue({ data: { ok: true } });
});

afterEach(() => {
  cleanup();
  useActiveMatchStore.getState().setActiveMatch(null);
});

describe("the receiver", () => {
  it.each(["/trade", "/profile", "/arena", "/history"])("on %s: who, duration, starting capital, ACCEPT and DECLINE", async (at) => {
    await mount("bob", at);
    const card = screen.getByTestId("challenge-card");
    expect(card.textContent).toContain("CHALLENGE FROM alice_t");
    expect(card.textContent).toContain("1H");
    expect(card.textContent).toContain("$50,000");
    expect(screen.getByRole("button", { name: "ACCEPT" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "DECLINE" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "WITHDRAW" })).toBeNull();
  });

  it("ACCEPT starts the match and goes to it", async () => {
    await mount("bob");
    api.getActiveMatch.mockResolvedValue(active(LIVE));
    await userEvent.click(screen.getByRole("button", { name: "ACCEPT" }));
    await flush();
    expect(api.acceptMatch).toHaveBeenCalledWith("m1");
    expect(where()).toBe("/trade");
    expect(screen.queryByTestId("challenge-card")).toBeNull();
  });

  it("DECLINE closes it", async () => {
    await mount("bob");
    api.getActiveMatch.mockResolvedValue(active(null));
    await userEvent.click(screen.getByRole("button", { name: "DECLINE" }));
    await flush();
    expect(api.cancelActiveMatch).toHaveBeenCalled();
    expect(screen.queryByTestId("challenge-card")).toBeNull();
  });

  it("a failed ACCEPT explains, and the card stays", async () => {
    api.acceptMatch.mockRejectedValue({ response: { data: { message: "This challenge was withdrawn." } } });
    await mount("bob");
    await userEvent.click(screen.getByRole("button", { name: "ACCEPT" }));
    await flush();
    expect(addToast).toHaveBeenCalledWith("error", "This challenge was withdrawn.");
    expect(where()).toBe("/profile");
  });

  it("buttons lock while a request is in flight", async () => {
    let finish!: () => void;
    api.cancelActiveMatch.mockReturnValue(new Promise((r) => { finish = () => r({ data: { ok: true } }); }));
    await mount("bob");
    await userEvent.click(screen.getByRole("button", { name: "DECLINE" }));
    expect((screen.getByRole("button", { name: "ACCEPT" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "DECLINE" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { finish(); });
  });
});

describe("the sender", () => {
  it("WAITING FOR the opponent, with WITHDRAW only", async () => {
    await mount("alice");
    const card = screen.getByTestId("challenge-card");
    expect(card.textContent).toContain("WAITING FOR bob_t");
    expect(card.textContent).toContain("1H");
    expect(screen.getByRole("button", { name: "WITHDRAW" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "ACCEPT" })).toBeNull();
    expect(screen.queryByRole("button", { name: "DECLINE" })).toBeNull();
  });

  it("WITHDRAW closes it", async () => {
    await mount("alice");
    api.getActiveMatch.mockResolvedValue(active(null));
    await userEvent.click(screen.getByRole("button", { name: "WITHDRAW" }));
    await flush();
    expect(api.cancelActiveMatch).toHaveBeenCalled();
    expect(screen.queryByTestId("challenge-card")).toBeNull();
  });
});

describe("driven by challenge events", () => {
  it("challenge.received shows it without a reload", async () => {
    api.getActiveMatch.mockResolvedValue(active(null));
    await mount("bob");
    expect(screen.queryByTestId("challenge-card")).toBeNull();
    api.getActiveMatch.mockResolvedValue(active(PENDING));
    fire("sse:challenge.received", { matchId: "m1", challengerId: "alice", challengerName: "alice_t", duration: 1 });
    await flush();
    expect(screen.getByTestId("challenge-card").textContent).toContain("CHALLENGE FROM alice_t");
  });

  it("challenge.closed (declined or withdrawn by the other side) takes it away", async () => {
    await mount("alice");
    api.getActiveMatch.mockResolvedValue(active(null));
    fire("sse:challenge.closed", { matchId: "m1", reason: "declined", byName: "bob_t" });
    await flush();
    expect(screen.queryByTestId("challenge-card")).toBeNull();
  });

  it("match.started (accepted on another tab) takes it away", async () => {
    await mount("alice");
    api.getActiveMatch.mockResolvedValue(active(LIVE));
    fire("sse:match.started");
    await flush();
    expect(screen.queryByTestId("challenge-card")).toBeNull();
  });

  it("no pending challenge, or a live match: no card", async () => {
    api.getActiveMatch.mockResolvedValue(active(LIVE));
    await mount("bob");
    expect(screen.queryByTestId("challenge-card")).toBeNull();
  });
});
