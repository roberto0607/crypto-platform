import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";

vi.mock("@/api/endpoints/friends", () => ({
    sendFriendRequest: vi.fn(),
    acceptFriendRequest: vi.fn(),
    rejectFriendRequest: vi.fn(),
    blockUser: vi.fn(),
    listFriends: vi.fn().mockResolvedValue({
        data: { ok: true, friends: [], incomingRequests: [], outgoingRequests: [] },
    }),
}));

vi.mock("@/api/endpoints/conversations", () => ({
    getOrCreateDmConversation: vi.fn(),
    listConversations: vi.fn().mockResolvedValue({ data: { ok: true, conversations: [] } }),
    listMessages: vi.fn().mockResolvedValue({ data: { ok: true, data: [], nextCursor: null } }),
    sendMessage: vi.fn(),
}));

import { useChatStore } from "@/stores/chatStore";
import ToastProvider from "@/components/ToastProvider";
import MessagesPage from "@/pages/MessagesPage";
import type { Conversation } from "@/types/api";

function conversation(overrides: Partial<Conversation> = {}): Conversation {
    return {
        id: "c1",
        type: "dm",
        context_id: null,
        created_at: "2026-07-01T00:00:00Z",
        other_user_id: "them",
        other_display_name: "Bob",
        ...overrides,
    };
}

beforeEach(() => {
    useChatStore.setState({
        conversations: [conversation()],
        conversationsLoaded: true,
        activeConversationId: null,
        messagesByConversation: {},
        friendsLoaded: true,
    });
});

function renderAt(path: string) {
    return render(
        <ToastProvider>
            <MemoryRouter initialEntries={[path]}>
                <Routes>
                    <Route path="/messages" element={<MessagesPage />} />
                    <Route path="/messages/:conversationId" element={<MessagesPage />} />
                    <Route path="/trade" element={<div>Trade page</div>} />
                </Routes>
            </MemoryRouter>
        </ToastProvider>,
    );
}

describe("MessagesPage — activeConversationId lifecycle", () => {
    it("a deep link sets the conversation active", () => {
        renderAt("/messages/c1");
        expect(useChatStore.getState().activeConversationId).toBe("c1");
    });

    // Regression test for a real bug caught via Playwright: chatStore.
    // activeConversationId stayed set to the last-viewed conversation after
    // switching to the Requests tab, so onMessageReceived kept treating new
    // messages as "already seen" and never incremented the unread badge.
    it("switching to the Requests tab clears activeConversationId", async () => {
        renderAt("/messages/c1");
        expect(useChatStore.getState().activeConversationId).toBe("c1");

        await userEvent.click(screen.getByRole("button", { name: "Requests" }));

        expect(useChatStore.getState().activeConversationId).toBeNull();
    });

    it("switching back to Chats without a deep link does not resurrect the old id", async () => {
        renderAt("/messages/c1");
        await userEvent.click(screen.getByRole("button", { name: "Requests" }));
        expect(useChatStore.getState().activeConversationId).toBeNull();

        await userEvent.click(screen.getByRole("button", { name: "Chats" }));

        expect(useChatStore.getState().activeConversationId).toBeNull();
    });

    it("unmounting the page (e.g. navigating away) clears activeConversationId", () => {
        const { unmount } = renderAt("/messages/c1");
        expect(useChatStore.getState().activeConversationId).toBe("c1");

        unmount();

        expect(useChatStore.getState().activeConversationId).toBeNull();
    });
});
