import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { useState } from "react";

const searchPlayers = vi.hoisted(() => vi.fn());
vi.mock("@/api/endpoints/users", () => ({ searchPlayers }));

import { PlayerSearch } from "@/components/arena/PlayerSearch";
import type { PublicPlayer } from "@/api/endpoints/users";

const player = (username: string, id = username): PublicPlayer => ({
  id, username, tier: "PRO", elo: 1250, wins: 3, losses: 1,
});

function Harness({ initial = null }: { initial?: PublicPlayer | null }) {
  const [value, setValue] = useState<PublicPlayer | null>(initial);
  return (
    <>
      <PlayerSearch value={value} onChange={setValue} />
      <div data-testid="picked">{value?.id ?? "none"}</div>
    </>
  );
}

const input = () => screen.getByRole("combobox");
const type = (text: string) => fireEvent.change(input(), { target: { value: text } });
const press = (key: string) => fireEvent.keyDown(input(), { key });

describe("PlayerSearch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    searchPlayers.mockResolvedValue({ data: { users: [player("alice"), player("alicia"), player("alina")] } });
  });

  it("shows the search placeholder", () => {
    render(<Harness />);
    expect(screen.getByPlaceholderText("Search player…")).toBeInTheDocument();
  });

  it("debounces: one request for a burst of typing, with the last term", async () => {
    render(<Harness />);
    type("al");
    type("ali");
    type("alic");
    await screen.findByRole("option", { name: /alice/ });
    expect(searchPlayers).toHaveBeenCalledTimes(1);
    expect(searchPlayers).toHaveBeenCalledWith("alic");
  });

  it("doesn't search under 2 characters", async () => {
    render(<Harness />);
    type("a");
    await new Promise((r) => setTimeout(r, 350));
    expect(searchPlayers).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("shows the rank on each result", async () => {
    render(<Harness />);
    type("al");
    const option = await screen.findByRole("option", { name: /alice/ });
    expect(option).toHaveTextContent("PRO");
    expect(option).toHaveTextContent("1250");
  });

  it("moves with up/down, wraps, and Enter picks the highlighted player", async () => {
    render(<Harness />);
    type("al");
    await screen.findByRole("option", { name: /alice/ });
    expect(screen.getByRole("option", { name: /alice/ })).toHaveAttribute("aria-selected", "true");
    press("ArrowDown");
    expect(screen.getByRole("option", { name: /alicia/ })).toHaveAttribute("aria-selected", "true");
    press("ArrowUp");
    press("ArrowUp");
    expect(screen.getByRole("option", { name: /alina/ })).toHaveAttribute("aria-selected", "true");
    press("ArrowDown");
    press("ArrowDown");
    press("Enter");
    expect(screen.getByTestId("picked")).toHaveTextContent("alicia");
  });

  it("Esc closes the list and keeps the text", async () => {
    render(<Harness />);
    type("al");
    await screen.findByRole("listbox");
    press("Escape");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(input()).toHaveValue("al");
  });

  it("clicking a result picks it and shows a chip with username and rank", async () => {
    render(<Harness />);
    type("al");
    fireEvent.mouseDown(await screen.findByRole("option", { name: /alina/ }));
    expect(screen.getByTestId("picked")).toHaveTextContent("alina");
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    const chip = screen.getByTestId("player-chip");
    expect(chip).toHaveTextContent("alina");
    expect(chip).toHaveTextContent("PRO");
  });

  it("clearing the chip goes back to searching", () => {
    render(<Harness initial={player("alina")} />);
    fireEvent.click(screen.getByRole("button", { name: /clear/i }));
    expect(screen.getByTestId("picked")).toHaveTextContent("none");
    expect(input()).toBeInTheDocument();
  });

  it("says when nobody matches", async () => {
    searchPlayers.mockResolvedValue({ data: { users: [] } });
    render(<Harness />);
    type("zzz");
    expect(await screen.findByText("No players found")).toBeInTheDocument();
  });

  it("says when search fails, and when it's rate limited", async () => {
    searchPlayers.mockRejectedValueOnce({ response: { status: 500 } });
    render(<Harness />);
    type("zzz");
    expect(await screen.findByText(/search isn't working/i)).toBeInTheDocument();
    searchPlayers.mockRejectedValueOnce({ response: { status: 429 } });
    type("zzzz");
    expect(await screen.findByText(/too many searches/i)).toBeInTheDocument();
  });

  it("ignores a slow earlier response that lands after a newer one", async () => {
    let finishFirst: (v: unknown) => void = () => {};
    searchPlayers
      .mockImplementationOnce(() => new Promise((resolve) => { finishFirst = resolve; }))
      .mockResolvedValueOnce({ data: { users: [player("newer")] } });
    render(<Harness />);
    type("ol");
    await waitFor(() => expect(searchPlayers).toHaveBeenCalledTimes(1));
    type("new");
    await screen.findByRole("option", { name: /newer/ });
    finishFirst({ data: { users: [player("older")] } });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole("option", { name: /older/ })).not.toBeInTheDocument();
  });
});
