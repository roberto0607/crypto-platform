import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

const getPlayer = vi.hoisted(() => vi.fn());
vi.mock("@/api/endpoints/users", () => ({ getPlayer }));

import PlayerProfilePage from "@/pages/PlayerProfilePage";
import { useAuthStore } from "@/stores/authStore";

function Where() {
  const loc = useLocation();
  return <div data-testid="where">{loc.pathname + loc.search}</div>;
}

function renderAt(name: string) {
  render(
    <MemoryRouter initialEntries={[`/players/${name}`]}>
      <Routes>
        <Route path="/players/:username" element={<PlayerProfilePage />} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
}

const BOB = { id: "bob-id", username: "bob_t", tier: "PRO", elo: 1250, wins: 7, losses: 3 };

describe("PlayerProfilePage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuthStore.setState({ user: { id: "me", email: "a@b.co", role: "USER" } });
    getPlayer.mockResolvedValue({ data: { player: BOB } });
  });

  it("shows the public card, and ⚔️ Challenge opens the box pre-filled", async () => {
    renderAt("bob_t");
    expect(await screen.findByText("@bob_t")).toBeInTheDocument();
    expect(screen.getByText("PRO")).toBeInTheDocument();
    expect(screen.getByText("1250 ELO")).toBeInTheDocument();
    expect(screen.getByText("7W – 3L")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /challenge/i }));
    expect(screen.getByTestId("where").textContent).toBe("/arena?challenge=bob_t");
  });

  it("offers no challenge on your own page", async () => {
    getPlayer.mockResolvedValue({ data: { player: { ...BOB, id: "me" } } });
    renderAt("bob_t");
    await screen.findByText("@bob_t");
    expect(screen.queryByRole("button", { name: /challenge/i })).not.toBeInTheDocument();
  });

  it("says when the player doesn't exist", async () => {
    getPlayer.mockRejectedValue({ response: { status: 404 } });
    renderAt("ghost");
    expect(await screen.findByText(/player not found/i)).toBeInTheDocument();
  });
});
