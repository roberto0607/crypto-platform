import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

vi.mock("@/api/endpoints/friends", () => ({
    sendFriendRequest: vi.fn(),
    acceptFriendRequest: vi.fn(),
    rejectFriendRequest: vi.fn(),
    blockUser: vi.fn(),
    listFriends: vi.fn().mockResolvedValue({
        data: { ok: true, friends: [], incomingRequests: [], outgoingRequests: [] },
    }),
}));

import { useChatStore } from "@/stores/chatStore";
import { MessagesPanel } from "@/components/trading/MessagesPanel";
import type { Friendship } from "@/types/api";

function friendship(overrides: Partial<Friendship> = {}): Friendship {
    return {
        id: "f1",
        user_id: "them",
        friend_id: "me",
        status: "pending",
        created_at: "2026-07-01T00:00:00Z",
        updated_at: "2026-07-01T00:00:00Z",
        other_user_id: "them",
        other_display_name: "Bob",
        ...overrides,
    };
}

beforeEach(() => {
    useChatStore.setState({ friends: [], incomingRequests: [], outgoingRequests: [], friendsLoaded: false });
});

function renderPanel() {
    return render(
        <MemoryRouter>
            <MessagesPanel />
        </MemoryRouter>,
    );
}

describe("MessagesPanel", () => {
    it("shows no badge when there are no pending requests", () => {
        renderPanel();
        expect(screen.queryByText(/^\d+$/)).not.toBeInTheDocument();
    });

    it("shows a badge with the pending incoming request count", () => {
        useChatStore.setState({ incomingRequests: [friendship({ id: "a" }), friendship({ id: "b" })], friendsLoaded: true });
        renderPanel();
        expect(screen.getByText("2")).toBeInTheDocument();
    });

    it("caps the badge display at 9+", () => {
        useChatStore.setState({
            incomingRequests: Array.from({ length: 12 }, (_, i) => friendship({ id: `f${i}` })),
        });
        renderPanel();
        expect(screen.getByText("9+")).toBeInTheDocument();
    });

    it("opens the preview dropdown and lists pending requests on click", async () => {
        useChatStore.setState({ incomingRequests: [friendship({ other_display_name: "Bob" })], friendsLoaded: true });
        renderPanel();

        await userEvent.click(screen.getByRole("button", { name: "Messages" }));

        expect(screen.getByText("Bob")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Accept" })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Reject" })).toBeInTheDocument();
    });

    it("shows an empty state when open with no pending requests", async () => {
        renderPanel();
        await userEvent.click(screen.getByRole("button", { name: "Messages" }));
        expect(screen.getByText("No pending requests")).toBeInTheDocument();
    });
});
