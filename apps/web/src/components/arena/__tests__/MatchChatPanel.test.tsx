import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const listMatchChatMessagesApi = vi.fn();
const sendMatchChatMessageApi = vi.fn();

vi.mock("@/api/endpoints/matchChat", () => ({
    listMatchChatMessages: (matchId: string, params: unknown) => listMatchChatMessagesApi(matchId, params),
    sendMatchChatMessage: (matchId: string, body: string) => sendMatchChatMessageApi(matchId, body),
}));

import { useAuthStore } from "@/stores/authStore";
import { MatchChatPanel } from "@/components/arena/MatchChatPanel";
import type { Message, MessageReceivedEvent } from "@/types/api";

function message(overrides: Partial<Message> = {}): Message {
    return {
        id: "m1",
        conversation_id: "conv-1",
        sender_id: "opponent",
        body: "hi",
        image_url: null,
        created_at: "2026-07-27T12:00:00Z",
        read_at: null,
        ...overrides,
    };
}

function dispatchMessageReceived(overrides: Partial<MessageReceivedEvent> = {}) {
    const detail: MessageReceivedEvent = {
        conversationId: "conv-1",
        conversationType: "match",
        messageId: "m-sse",
        senderId: "opponent",
        senderName: "Opponent",
        body: "live message",
        imageUrl: null,
        createdAt: "2026-07-27T12:05:00Z",
        ...overrides,
    };
    window.dispatchEvent(new CustomEvent("sse:message.received", { detail }));
}

beforeEach(() => {
    listMatchChatMessagesApi.mockReset();
    sendMatchChatMessageApi.mockReset();
    listMatchChatMessagesApi.mockResolvedValue({ data: { ok: true, data: [], nextCursor: null } });
    useAuthStore.setState({ user: { id: "me", email: "me@test.com", role: "USER" } as any });
});

function renderPanel(props: Partial<React.ComponentProps<typeof MatchChatPanel>> = {}) {
    return render(
        <MatchChatPanel
            matchId="match-1"
            opponentName="Opponent"
            isOpen={true}
            onClose={vi.fn()}
            {...props}
        />,
    );
}

describe("MatchChatPanel", () => {
    it("fetches history for the match on mount and shows the opponent's name", async () => {
        listMatchChatMessagesApi.mockResolvedValue({
            data: { ok: true, data: [message({ id: "m1", body: "hey there", sender_id: "opponent" })], nextCursor: null },
        });
        renderPanel();
        expect(listMatchChatMessagesApi).toHaveBeenCalledWith("match-1", undefined);
        expect(screen.getByText("CHAT — Opponent")).toBeInTheDocument();
        await waitFor(() => expect(screen.getByText("hey there")).toBeInTheDocument());
    });

    it("shows an empty state when there's no history", async () => {
        renderPanel();
        await waitFor(() => expect(screen.getByText("No messages yet. Say hi.")).toBeInTheDocument());
    });

    it("sends a message, appends it locally, and clears the draft", async () => {
        sendMatchChatMessageApi.mockResolvedValue({
            data: { ok: true, message: message({ id: "m-new", body: "gl hf", sender_id: "me" }) },
        });
        renderPanel();
        await waitFor(() => expect(screen.getByText("No messages yet. Say hi.")).toBeInTheDocument());

        const input = screen.getByPlaceholderText("Message...");
        await userEvent.type(input, "gl hf");
        await userEvent.click(screen.getByRole("button", { name: "SEND" }));

        expect(sendMatchChatMessageApi).toHaveBeenCalledWith("match-1", "gl hf");
        await waitFor(() => expect(screen.getByText("gl hf")).toBeInTheDocument());
        expect(input).toHaveValue("");
    });

    it("disables SEND when the draft is empty", async () => {
        renderPanel();
        await waitFor(() => expect(screen.getByRole("button", { name: "SEND" })).toBeDisabled());
    });

    it("appends an incoming match message pushed over sse:message.received", async () => {
        renderPanel();
        await waitFor(() => expect(screen.getByText("No messages yet. Say hi.")).toBeInTheDocument());

        dispatchMessageReceived({ body: "good luck!", senderId: "opponent" });

        await waitFor(() => expect(screen.getByText("good luck!")).toBeInTheDocument());
    });

    it("ignores a DM-conversationType push (never mixes DM into match chat)", async () => {
        renderPanel();
        await waitFor(() => expect(screen.getByText("No messages yet. Say hi.")).toBeInTheDocument());

        dispatchMessageReceived({ conversationType: "dm", body: "unrelated dm" });

        // Give any (incorrect) handler a tick to run, then assert nothing changed.
        await new Promise((r) => setTimeout(r, 0));
        expect(screen.queryByText("unrelated dm")).not.toBeInTheDocument();
        expect(screen.getByText("No messages yet. Say hi.")).toBeInTheDocument();
    });

    it("distinguishes my messages from the opponent's via sender_id", async () => {
        listMatchChatMessagesApi.mockResolvedValue({
            data: {
                ok: true,
                data: [
                    message({ id: "mine", body: "mine", sender_id: "me" }),
                    message({ id: "theirs", body: "theirs", sender_id: "opponent" }),
                ],
                nextCursor: null,
            },
        });
        const { container } = renderPanel();
        await waitFor(() => expect(screen.getByText("mine")).toBeInTheDocument());

        const mineBubble = screen.getByText("mine").closest(".lmv-chat-msg");
        const theirsBubble = screen.getByText("theirs").closest(".lmv-chat-msg");
        expect(mineBubble).toHaveClass("mine");
        expect(theirsBubble).not.toHaveClass("mine");
        expect(container.querySelectorAll(".lmv-chat-msg")).toHaveLength(2);
    });

    it("re-fetches a fresh (empty) history when matchId changes", async () => {
        listMatchChatMessagesApi.mockResolvedValueOnce({
            data: { ok: true, data: [message({ id: "m1", body: "old match msg" })], nextCursor: null },
        });
        const { rerender } = renderPanel({ matchId: "match-1" });
        await waitFor(() => expect(screen.getByText("old match msg")).toBeInTheDocument());

        listMatchChatMessagesApi.mockResolvedValueOnce({ data: { ok: true, data: [], nextCursor: null } });
        rerender(<MatchChatPanel matchId="match-2" opponentName="Opponent" isOpen={true} onClose={vi.fn()} />);

        expect(listMatchChatMessagesApi).toHaveBeenCalledWith("match-2", undefined);
        await waitFor(() => expect(screen.queryByText("old match msg")).not.toBeInTheDocument());
        expect(screen.getByText("No messages yet. Say hi.")).toBeInTheDocument();
    });

    it("applies the open class only when isOpen is true (stays mounted when closed)", async () => {
        const { container, rerender } = renderPanel({ isOpen: false });
        await waitFor(() => expect(listMatchChatMessagesApi).toHaveBeenCalled());
        expect(container.querySelector(".lmv-chat-panel")).not.toHaveClass("open");

        rerender(<MatchChatPanel matchId="match-1" opponentName="Opponent" isOpen={true} onClose={vi.fn()} />);
        expect(container.querySelector(".lmv-chat-panel")).toHaveClass("open");
    });

    it("calls onClose when the close button is clicked", async () => {
        const onClose = vi.fn();
        renderPanel({ onClose });
        await waitFor(() => expect(listMatchChatMessagesApi).toHaveBeenCalled());
        await userEvent.click(screen.getByRole("button", { name: "Close chat" }));
        expect(onClose).toHaveBeenCalledTimes(1);
    });
});
