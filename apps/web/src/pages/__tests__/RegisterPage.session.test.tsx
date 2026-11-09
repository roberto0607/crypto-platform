import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

const register = vi.hoisted(() => vi.fn());
vi.mock("@/api/endpoints/auth", () => ({ register }));
vi.mock("@/api/endpoints/status", () => ({
  getSystemStatus: vi.fn(() => Promise.resolve({ data: { betaMode: false } })),
}));

import RegisterPage from "@/pages/RegisterPage";
import { useAuthStore } from "@/stores/authStore";

function Where() {
  const loc = useLocation();
  return <div data-testid="where">{loc.pathname + loc.search}</div>;
}

function signUpAt(url: string) {
  render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/register" element={<RegisterPage />} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "a@b.co" } });
  fireEvent.change(screen.getByLabelText("Username"), { target: { value: "New_Name" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "pw-123456" } });
  fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: "pw-123456" } });
  fireEvent.submit(document.querySelector("form")!);
}

describe("RegisterPage: signing up logs you in", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuthStore.setState({ user: null, accessToken: null, isAuthenticated: false, isInitializing: false });
    register.mockResolvedValue({
      data: { ok: true, accessToken: "tok", user: { id: "u1", email: "a@b.co", role: "USER", usernameChosen: true } },
    });
  });

  it("stores the session and opens the app, not the login page", async () => {
    signUpAt("/register");
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/trade"));
    expect(useAuthStore.getState()).toMatchObject({ accessToken: "tok", isAuthenticated: true });
    expect(useAuthStore.getState().user?.id).toBe("u1");
  });

  it("keeps the redirect (an invite link)", async () => {
    signUpAt(`/register?redirect=${encodeURIComponent("/challenge/bob_t")}`);
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/challenge/bob_t"));
  });

  it("a failed signup stays on the form, logged out", async () => {
    register.mockRejectedValue({ response: { data: { ok: false, error: "username_taken" } } });
    signUpAt("/register");
    expect(await screen.findByText("That username is taken")).toBeInTheDocument();
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
  });
});
