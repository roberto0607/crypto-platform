import { pool } from "../db/pool.js";
import { publish } from "../events/eventBus.js";
import { createEvent } from "../events/eventTypes.js";
import { AppError } from "../errors/AppError.js";
import { findFriendshipBetween } from "../friends/friendshipRepo.js";
import { containsProfanity } from "./profanityFilter.js";
import {
    getConversationById,
    findDmConversationBetween,
    createDmConversation,
    isParticipant,
    getOtherParticipants,
    listDmConversationsForUser,
    type ConversationRow,
    type ConversationListRow,
} from "./conversationRepo.js";
import { insertMessage, listMessagesPaginated, type MessageRow } from "./messageRepo.js";

const MAX_MESSAGE_LENGTH = 2000;

async function getDisplayName(userId: string): Promise<string> {
    const { rows } = await pool.query<{ display_name: string | null }>(
        `SELECT display_name FROM users WHERE id = $1`,
        [userId],
    );
    return rows[0]?.display_name ?? "Unknown";
}

export async function getOrCreateDmConversation(
    userId: string,
    friendId: string,
): Promise<ConversationRow> {
    if (userId === friendId) {
        throw new AppError("cannot_friend_self");
    }

    const friendship = await findFriendshipBetween(userId, friendId);
    if (!friendship || friendship.status !== "accepted") {
        throw new AppError("friendship_required");
    }

    const existing = await findDmConversationBetween(userId, friendId);
    if (existing) return existing;

    return createDmConversation(userId, friendId);
}

export async function listMyConversations(userId: string): Promise<ConversationListRow[]> {
    return listDmConversationsForUser(userId);
}

/** Throws conversation_not_found or forbidden; returns the row otherwise. */
async function requireParticipant(conversationId: string, userId: string): Promise<ConversationRow> {
    const conversation = await getConversationById(conversationId);
    if (!conversation) throw new AppError("conversation_not_found");
    if (!(await isParticipant(conversationId, userId))) throw new AppError("forbidden");
    return conversation;
}

export async function sendMessage(
    conversationId: string,
    senderId: string,
    body: string,
): Promise<MessageRow> {
    const conversation = await requireParticipant(conversationId, senderId);

    const trimmed = body.trim();
    if (trimmed.length === 0) {
        throw new AppError("message_empty");
    }
    if (trimmed.length > MAX_MESSAGE_LENGTH) {
        throw new AppError("invalid_input");
    }
    if (containsProfanity(trimmed)) {
        throw new AppError("message_contains_profanity");
    }

    const message = await insertMessage(conversationId, senderId, trimmed);
    const senderName = await getDisplayName(senderId);
    const recipients = await getOtherParticipants(conversationId, senderId);

    for (const recipientId of recipients) {
        publish(createEvent("message.received", {
            conversationId,
            conversationType: conversation.type,
            messageId: message.id,
            senderId,
            senderName,
            body: message.body,
            imageUrl: message.image_url,
            createdAt: message.created_at,
        }, { userId: recipientId }));
    }

    return message;
}

export async function listMessages(
    conversationId: string,
    userId: string,
    limit: number,
    cursor: { ca: string; id: string } | null,
): Promise<MessageRow[]> {
    await requireParticipant(conversationId, userId);
    return listMessagesPaginated(conversationId, limit, cursor);
}
