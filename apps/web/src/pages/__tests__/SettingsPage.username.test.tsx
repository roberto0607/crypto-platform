import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const updateDisplayName = vi.hoisted(() => vi.fn());
vi.mock("@/api/endpoints/profile", () => ({ updateDisplayName }));
vi.mock("@/api/endpoints/apiKeys", () => ({
  list: vi.fn(() => Promise.resolve({ data: { apiKeys: [] } })),
  create: vi.fn(),
  revoke: vi.fn(),
}));

import SettingsPage from "@/pages/SettingsPage";
import { useAuthStore } from "@/stores/authStore";

function save(name: string) {
  fireEvent.change(screen.getByLabelText("Username"), { target: { value: name } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
}

describe("SettingsPage username", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuthStore.setState({
      user: { id: "u1", email: "a@b.co", role: "USER", displayName: "trader_0123456789", usernameChosen: false },
    });
    render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>,
    );
  });

  it("updates the signed-in user, so the banner and header change without a reload", async () => {
    updateDisplayName.mockResolvedValue({ data: { ok: true, displayName: "New_Name" } });
    save("New_Name");
    await waitFor(() => expect(useAuthStore.getState().user?.displayName).toBe("New_Name"));
    expect(useAuthStore.getState().user?.usernameChosen).toBe(true);
    expect(await screen.findByText("Saved!")).toBeInTheDocument();
  });

  it.each([
    ["username_taken", "That username is taken"],
    ["username_reserved", "That username is reserved"],
  ])("explains %s", async (error, message) => {
    updateDisplayName.mockRejectedValue({ response: { data: { ok: false, error } } });
    save("Some_Name");
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(useAuthStore.getState().user?.displayName).toBe("trader_0123456789");
  });
});
