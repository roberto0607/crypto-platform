import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";

// ReplayPage calls getActive() once on mount to check for an existing
// session. Mock the endpoint module so this smoke test verifies routing
// only, without depending on a live API.
vi.mock("@/api/endpoints/replay", () => ({
  getActive: vi.fn().mockResolvedValue({ data: { session: null } }),
  start: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  seek: vi.fn(),
  stop: vi.fn(),
}));

import ReplayPage from "@/pages/ReplayPage";

describe("/replay route", () => {
  it("renders ReplayPage when navigated to /replay", () => {
    render(
      <MemoryRouter initialEntries={["/replay"]}>
        <Routes>
          <Route path="/replay" element={<ReplayPage />} />
        </Routes>
      </MemoryRouter>,
    );

    // The replay configuration panel is part of ReplayPage's initial
    // (no active session) render — proves the page mounted, not redirected.
    expect(screen.getByText("Replay Configuration")).toBeInTheDocument();
  });
});
