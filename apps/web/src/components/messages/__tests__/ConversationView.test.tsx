import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const sendMessageApi = vi.fn();
const listMessagesApi = vi.fn();

vi.mock("@/api/endpoints/conversations", () => ({
    getOrCreateDmConversation: vi.fn(),
    listConversations: vi.fn(),
    listMessages: (id: string, params: unknown) => listMessagesApi(id, params),
    sendMessage: (id: string, body: string) => sendMessageApi(id, body),
}));

import { useChatStore } from "@/stores/chatStore";
import { useAuthStore } from "@/stores/authStore";
import { ConversationView } from "@/components/messages/ConversationView";
import ToastProvider from "@/components/ToastProvider";
import type { Conversation, Message } from "@/types/api";

function renderView() {
    return render(
        <ToastProvider>
            <ConversationView />
        </ToastProvider>,
    );
}

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

function message(overrides: Partial<Message> = {}): Message {
    return {
        id: "m1",
        conversation_id: "c1",
        sender_id: "them",
        body: "hi",
        image_url: null,
        created_at: "2026-07-01T00:00:00Z",
        read_at: null,
        ...overrides,
    };
}

beforeEach(() => {
    sendMessageApi.mockReset();
    listMessagesApi.mockReset();
    useChatStore.setState({
        conversations: [],
        activeConversationId: null,
        messagesByConversation: {},
        messageCursors: {},
    });
    useAuthStore.setState({ user: { id: "me", email: "me@test.com", role: "USER" } });
});

describe("ConversationView", () => {
    it("shows a placeholder when no conversation is active", () => {
        renderView();
        expect(screen.getByText("Select a conversation")).toBeInTheDocument();
    });

    it("renders the conversation header and message history", () => {
        useChatStore.setState({
            conversations: [conversation()],
            activeConversationId: "c1",
            messagesByConversation: { c1: [message({ id: "m1", body: "hey there", sender_id: "them" })] },
        });
        renderView();
        expect(screen.getByText("Bob")).toBeInTheDocument();
        expect(screen.getByText("hey there")).toBeInTheDocument();
    });

    it("shows the Load older messages button only when a cursor exists", () => {
        useChatStore.setState({
            conversations: [conversation()],
            activeConversationId: "c1",
            messagesByConversation: { c1: [message()] },
            messageCursors: { c1: "cursor-1" },
        });
        renderView();
        expect(screen.getByRole("button", { name: "Load older messages" })).toBeInTheDocument();
    });

    it("does not show Load older when there's no more pages", () => {
        useChatStore.setState({
            conversations: [conversation()],
            activeConversationId: "c1",
            messagesByConversation: { c1: [message()] },
            messageCursors: { c1: null },
        });
        renderView();
        expect(screen.queryByRole("button", { name: "Load older messages" })).not.toBeInTheDocument();
    });

    it("sends a message and clears the draft on success", async () => {
        useChatStore.setState({ conversations: [conversation()], activeConversationId: "c1" });
        sendMessageApi.mockResolvedValue({ data: { ok: true, message: message({ id: "m-new", body: "yo", sender_id: "me" }) } });

        renderView();
        const input = screen.getByPlaceholderText("Message...");
        await userEvent.type(input, "yo");
        await userEvent.click(screen.getByRole("button", { name: "Send" }));

        expect(sendMessageApi).toHaveBeenCalledWith("c1", "yo");
        expect(input).toHaveValue("");
    });

    it("disables Send when the draft is empty", () => {
        useChatStore.setState({ conversations: [conversation()], activeConversationId: "c1" });
        renderView();
        expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    });
});
