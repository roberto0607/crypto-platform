import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import ToastProvider from "@/components/ToastProvider";
import { CopyInviteLink } from "@/components/arena/CopyInviteLink";
import { NotificationBell } from "@/components/NotificationBell";
import { useAuthStore } from "@/stores/authStore";
import { useNotificationStore } from "@/stores/notificationStore";

function Where() {
  const loc = useLocation();
  return <div data-testid="where">{loc.pathname}</div>;
}

const fire = (type: string, detail: unknown) =>
  act(() => { window.dispatchEvent(new CustomEvent(type, { detail })); });

describe("challenge toasts", () => {
  beforeEach(() => {
    render(<ToastProvider><div /></ToastProvider>);
  });

  it("challenge.received shows on any page, naming the challenger", () => {
    fire("sse:challenge.received", { matchId: "m1", challengerId: "a", challengerName: "alice_t", duration: 24, createdAt: "" });
    expect(screen.getByText(/alice_t challenged you/i)).toBeInTheDocument();
  });

  it("challenge.closed says who declined or withdrew", () => {
    fire("sse:challenge.closed", { matchId: "m1", reason: "declined", byName: "bob_t" });
    expect(screen.getByText(/bob_t declined your challenge/i)).toBeInTheDocument();
    fire("sse:challenge.closed", { matchId: "m2", reason: "withdrawn", byName: "alice_t" });
    expect(screen.getByText(/alice_t withdrew their challenge/i)).toBeInTheDocument();
  });
});

describe("bell", () => {
  it("a challenge notification opens the Arena and marks itself read", () => {
    const markRead = vi.fn();
    useNotificationStore.setState({
      notifications: [{
        id: "n1", kind: "CHALLENGE_RECEIVED", title: "alice_t challenged you to a 1v1", body: null,
        read_at: null, created_at: "2026-11-04T00:00:00Z",
      }] as never,
      unreadCount: 1, panelOpen: true, markRead, fetch: vi.fn(() => Promise.resolve()),
    });
    render(<MemoryRouter><NotificationBell /><Where /></MemoryRouter>);
    fireEvent.click(screen.getByText(/alice_t challenged you/));
    expect(markRead).toHaveBeenCalledWith("n1");
    expect(screen.getByTestId("where").textContent).toBe("/arena");
  });
});

describe("CopyInviteLink", () => {
  it("copies this site's invite link for your username", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.assign(navigator, { clipboard: { writeText } });
    useAuthStore.setState({ user: { id: "me", email: "a@b.co", role: "USER", displayName: "roberto" } });
    render(<CopyInviteLink />);
    fireEvent.click(screen.getByRole("button", { name: /copy invite link/i }));
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/challenge/roberto`);
    expect(await screen.findByText(/copied/i)).toBeInTheDocument();
  });
});
