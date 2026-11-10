import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

vi.mock("@/api/endpoints/auth", () => ({
  login: vi.fn(() => Promise.resolve({
    data: { accessToken: "tok", user: { id: "u1", email: "a@b.co", role: "USER" } },
  })),
  register: vi.fn(() => Promise.resolve({
    data: { ok: true, accessToken: "tok2", user: { id: "u2", email: "a@b.co", role: "USER" } },
  })),
  me: vi.fn(),
  logout: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/api/endpoints/status", () => ({
  getSystemStatus: vi.fn(() => Promise.resolve({ data: { betaMode: false } })),
}));

import ProtectedRoute from "@/components/ProtectedRoute";
import ChallengeInvitePage from "@/pages/ChallengeInvitePage";
import LoginPage from "@/pages/LoginPage";
import RegisterPage from "@/pages/RegisterPage";
import { useAuthStore } from "@/stores/authStore";

function Where() {
  const loc = useLocation();
  return <div data-testid="where">{loc.pathname + loc.search}</div>;
}

function renderAt(url: string) {
  render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route element={<ProtectedRoute />}>
          <Route path="/challenge/:username" element={<ChallengeInvitePage />} />
          <Route path="/arena" element={<Where />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

function logIn() {
  fireEvent.change(document.querySelector('input[type="email"]')!, { target: { value: "a@b.co" } });
  fireEvent.change(document.querySelector('input[type="password"]')!, { target: { value: "pw-123456" } });
  fireEvent.submit(document.querySelector("form")!);
}

describe("invite link /challenge/:username", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuthStore.setState({ user: null, accessToken: null, isAuthenticated: false, isInitializing: false });
  });

  it("logged in: lands on the pre-filled challenge", async () => {
    useAuthStore.setState({ isAuthenticated: true, user: { id: "u1", email: "a@b.co", role: "USER" } });
    renderAt("/challenge/bob_t");
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/arena?challenge=bob_t"));
  });

  it("logged out, existing account: login, then the pre-filled challenge", async () => {
    renderAt("/challenge/bob_t");
    await screen.findByText(/create one free/i);
    logIn();
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/arena?challenge=bob_t"));
  });

  it("logged out, new account: signup logs in and lands on the pre-filled challenge", async () => {
    renderAt("/challenge/bob_t");
    fireEvent.click(await screen.findByText(/create one free/i));

    fireEvent.change(await screen.findByLabelText("Email"), { target: { value: "a@b.co" } });
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "New_Name" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "pw-123456" } });
    fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: "pw-123456" } });
    fireEvent.submit(document.querySelector("form")!);

    // No login page in between: signing up is logging in.
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/arena?challenge=bob_t"));
    expect(useAuthStore.getState().accessToken).toBe("tok2");
  });

  it("signup never forwards an off-site redirect", async () => {
    renderAt(`/register?redirect=${encodeURIComponent("//evil.com/x")}`);
    expect(await screen.findByRole("link", { name: /sign in|log in/i })).toHaveAttribute("href", "/login");
  });
});
