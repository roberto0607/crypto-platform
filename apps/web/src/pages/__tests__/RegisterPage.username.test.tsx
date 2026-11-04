import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const register = vi.hoisted(() => vi.fn());
vi.mock("@/api/endpoints/auth", () => ({ register }));
vi.mock("@/api/endpoints/status", () => ({
  getSystemStatus: vi.fn(() => Promise.resolve({ data: { betaMode: false } })),
}));

import RegisterPage from "@/pages/RegisterPage";

function fill(username: string) {
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "a@b.co" } });
  fireEvent.change(screen.getByLabelText("Username"), { target: { value: username } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "pw-123456" } });
  fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: "pw-123456" } });
  fireEvent.submit(document.querySelector("form")!);
}

describe("RegisterPage username", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    register.mockResolvedValue({ data: { ok: true } });
    render(
      <MemoryRouter>
        <RegisterPage />
      </MemoryRouter>,
    );
  });

  it("sends the chosen username", async () => {
    fill("My_Name");
    await waitFor(() => expect(register).toHaveBeenCalledWith("a@b.co", "pw-123456", undefined, "My_Name"));
  });

  it.each(["ab", "has space", "bad-name!", "a".repeat(31)])("refuses %j before calling the API", async (name) => {
    fill(name);
    expect(await screen.findByText(/must be 3-30 letters, numbers or underscores/i)).toBeInTheDocument();
    expect(register).not.toHaveBeenCalled();
  });

  it("shows a clear message when the name is taken", async () => {
    register.mockRejectedValue({ response: { data: { ok: false, error: "username_taken" } } });
    fill("Taken_Name");
    expect(await screen.findByText("That username is taken")).toBeInTheDocument();
  });
});
