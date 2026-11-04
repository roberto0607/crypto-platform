import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const cancelActiveMatch = vi.hoisted(() => vi.fn());
const addToast = vi.hoisted(() => vi.fn());
vi.mock("@/api/endpoints/matches", () => ({ cancelActiveMatch }));
vi.mock("@/components/ToastProvider", () => ({ useToast: () => ({ addToast }) }));

import { PendingChallengeCard } from "@/components/arena/PendingChallengeCard";
import type { Match } from "@/api/endpoints/matches";

const MATCH = {
  id: "m1", status: "PENDING", challenger_id: "alice", opponent_id: "bob",
  challenger_name: "alice_t", opponent_name: "bob_t",
} as Match;

describe("PendingChallengeCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cancelActiveMatch.mockResolvedValue({ data: { ok: true } });
  });

  it("the opponent sees who challenged them, with ACCEPT and DECLINE", async () => {
    const onAccept = vi.fn();
    const onClosed = vi.fn();
    render(<PendingChallengeCard match={MATCH} userId="bob" onAccept={onAccept} onClosed={onClosed} />);
    expect(screen.getByText(/alice_t challenged you/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "WITHDRAW" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "ACCEPT" }));
    expect(onAccept).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "DECLINE" }));
    await waitFor(() => expect(cancelActiveMatch).toHaveBeenCalled());
    await waitFor(() => expect(onClosed).toHaveBeenCalled());
  });

  it("the challenger sees who they're waiting on, with WITHDRAW only", async () => {
    const onClosed = vi.fn();
    render(<PendingChallengeCard match={MATCH} userId="alice" onAccept={vi.fn()} onClosed={onClosed} />);
    expect(screen.getByText(/waiting for bob_t/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "ACCEPT" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "DECLINE" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "WITHDRAW" }));
    await waitFor(() => expect(onClosed).toHaveBeenCalled());
  });

  it("reloads and explains if the cancel fails", async () => {
    cancelActiveMatch.mockRejectedValue({ response: { data: { message: "This match is gone." } } });
    const onClosed = vi.fn();
    render(<PendingChallengeCard match={MATCH} userId="bob" onAccept={vi.fn()} onClosed={onClosed} />);
    fireEvent.click(screen.getByRole("button", { name: "DECLINE" }));
    await waitFor(() => expect(addToast).toHaveBeenCalledWith("error", "This match is gone."));
    expect(onClosed).toHaveBeenCalled();
  });
});
