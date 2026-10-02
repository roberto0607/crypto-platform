import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

vi.mock("@/api/endpoints/auth", () => ({
  login: vi.fn(() =>
    Promise.resolve({ data: { accessToken: "tok", user: { id: "u1", email: "a@b.co", role: "USER" } } }),
  ),
}));

import LoginPage from "@/pages/LoginPage";

function Where() {
  const loc = useLocation();
  return <div data-testid="where">{loc.pathname + loc.search}</div>;
}

function renderAt(url: string) {
  render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
}

async function submit() {
  fireEvent.change(document.querySelector('input[type="email"]')!, { target: { value: "a@b.co" } });
  fireEvent.change(document.querySelector('input[type="password"]')!, { target: { value: "pw-123456" } });
  fireEvent.submit(document.querySelector("form")!);
}

describe("LoginPage redirect", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns to the protected page with its query (?debug=1 survives login)", async () => {
    renderAt(`/login?redirect=${encodeURIComponent("/trade?debug=1")}`);
    await submit();
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/trade?debug=1"));
  });

  it("ignores an off-site redirect and goes to /trade", async () => {
    renderAt(`/login?redirect=${encodeURIComponent("//evil.com/x")}`);
    await submit();
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/trade"));
  });

  it("defaults to /trade without a redirect param", async () => {
    renderAt("/login");
    await submit();
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/trade"));
  });
});
