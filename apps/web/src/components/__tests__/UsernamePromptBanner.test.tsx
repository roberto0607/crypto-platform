import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import UsernamePromptBanner from "@/components/UsernamePromptBanner";
import { useAuthStore } from "@/stores/authStore";
import type { User } from "@/types/api";

const USER: User = { id: "u1", email: "a@b.co", role: "USER", displayName: "trader_0123456789", usernameChosen: false };

function renderBanner(user: User | null) {
  useAuthStore.setState({ user });
  return render(
    <MemoryRouter>
      <UsernamePromptBanner />
    </MemoryRouter>,
  );
}

describe("UsernamePromptBanner", () => {
  beforeEach(() => localStorage.clear());

  it("asks a user holding a generated name to pick one, linking to Settings", () => {
    renderBanner(USER);
    expect(screen.getByText(/pick your username/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /pick your username/i })).toHaveAttribute("href", "/settings");
  });

  it("shows nothing once a name is chosen", () => {
    renderBanner({ ...USER, usernameChosen: true });
    expect(screen.queryByText(/pick your username/i)).not.toBeInTheDocument();
  });

  it("shows nothing while usernameChosen is unknown", () => {
    renderBanner({ ...USER, usernameChosen: undefined });
    expect(screen.queryByText(/pick your username/i)).not.toBeInTheDocument();
  });

  it("is one-time: dismissing it keeps it away after a reload", () => {
    const first = renderBanner(USER);
    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(screen.queryByText(/pick your username/i)).not.toBeInTheDocument();
    first.unmount();
    renderBanner(USER);
    expect(screen.queryByText(/pick your username/i)).not.toBeInTheDocument();
  });

  it("is one-time: following the link counts too", () => {
    const first = renderBanner(USER);
    fireEvent.click(screen.getByRole("link", { name: /pick your username/i }));
    first.unmount();
    renderBanner(USER);
    expect(screen.queryByText(/pick your username/i)).not.toBeInTheDocument();
  });

  it("remembers the dismissal per user, not per browser", () => {
    const first = renderBanner(USER);
    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    first.unmount();
    renderBanner({ ...USER, id: "u2" });
    expect(screen.getByText(/pick your username/i)).toBeInTheDocument();
  });
});
