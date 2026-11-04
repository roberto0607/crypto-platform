import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const api = vi.hoisted(() => ({
  searchPlayers: vi.fn(),
  getPlayer: vi.fn(),
  challengeUser: vi.fn(),
  cancelActiveMatch: vi.fn(),
}));
vi.mock("@/api/endpoints/users", () => ({ searchPlayers: api.searchPlayers, getPlayer: api.getPlayer }));
vi.mock("@/api/endpoints/matches", () => ({
  challengeUser: api.challengeUser,
  cancelActiveMatch: api.cancelActiveMatch,
}));

import { ChallengeBox } from "@/components/arena/ChallengeBox";
import { useAuthStore } from "@/stores/authStore";
import { useAppStore } from "@/stores/appStore";

const BOB = { id: "bob-id", username: "bob", tier: "ROOKIE", elo: 800, wins: 0, losses: 0 };
const challengeButton = () => screen.getByRole("button", { name: "CHALLENGE" });

function renderBox(url = "/arena", onChanged = vi.fn()) {
  render(
    <MemoryRouter initialEntries={[url]}>
      <ChallengeBox onChanged={onChanged} />
    </MemoryRouter>,
  );
  return onChanged;
}

describe("ChallengeBox", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuthStore.setState({ user: { id: "me", email: "a@b.co", role: "USER", displayName: "me_name" } });
    useAppStore.setState({ pairs: [{ id: "p1", is_active: true }] as never });
    api.searchPlayers.mockResolvedValue({ data: { users: [BOB] } });
    api.getPlayer.mockResolvedValue({ data: { player: BOB } });
    api.challengeUser.mockResolvedValue({ data: { ok: true } });
  });

  it("keeps CHALLENGE disabled until a player is picked, then sends the user id", async () => {
    const onChanged = renderBox();
    expect(challengeButton()).toBeDisabled();
    fireEvent.change(screen.getByRole("combobox", { name: "Search player" }), { target: { value: "bo" } });
    fireEvent.mouseDown(await screen.findByRole("option", { name: /bob/ }));
    expect(challengeButton()).toBeEnabled();
    fireEvent.click(challengeButton());
    await waitFor(() => expect(api.challengeUser).toHaveBeenCalledWith({
      opponentId: "bob-id", durationHours: 24, allowedPairIds: ["p1"],
    }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("no longer asks for a user id", () => {
    renderBox();
    expect(screen.queryByPlaceholderText(/user id/i)).not.toBeInTheDocument();
  });

  it("comes pre-filled from ?challenge=", async () => {
    renderBox("/arena?challenge=BOB");
    expect(await screen.findByTestId("player-chip")).toHaveTextContent("bob");
    expect(api.getPlayer).toHaveBeenCalledWith("BOB");
    expect(challengeButton()).toBeEnabled();
  });

  it("says a player wasn't found, in plain words", async () => {
    api.getPlayer.mockRejectedValue({ response: { status: 404, data: { code: "player_not_found" } } });
    renderBox("/arena?challenge=ghost");
    expect(await screen.findByText(/player "ghost" not found/i)).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Search player" })).toBeInTheDocument();
  });

  it("doesn't pre-fill yourself: your own link says so", async () => {
    api.getPlayer.mockResolvedValue({ data: { player: { ...BOB, id: "me" } } });
    renderBox("/arena?challenge=me_name");
    expect(await screen.findByText(/your own invite link/i)).toBeInTheDocument();
    expect(screen.queryByTestId("player-chip")).not.toBeInTheDocument();
  });

  it("shows the server's message when the challenge is refused", async () => {
    api.challengeUser.mockRejectedValue({
      response: { data: { code: "challenge_limit_reached", message: "You've sent 10 challenges in the last hour." } },
    });
    renderBox("/arena?challenge=bob");
    await screen.findByTestId("player-chip");
    fireEvent.click(challengeButton());
    expect(await screen.findByText(/10 challenges in the last hour/)).toBeInTheDocument();
  });

  it("offers CANCEL STUCK MATCH when a match blocks the challenge", async () => {
    api.challengeUser.mockRejectedValue({ response: { data: { code: "match_already_active" } } });
    renderBox("/arena?challenge=bob");
    await screen.findByTestId("player-chip");
    fireEvent.click(challengeButton());
    expect(await screen.findByRole("button", { name: /cancel stuck match/i })).toBeInTheDocument();
  });
});
