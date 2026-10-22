export const MESSAGE_MAX_LENGTH = 2000;
export const MESSAGE_LIMIT = 100;
// README du TP : messages temporaires pendant 24 heures.
export const MESSAGE_TTL_SECONDS = 24 * 60 * 60;

export function isUserId(value) {
    return Number.isInteger(value) && value > 0 && value <= 2147483647;
}

export function conversationKey(first, second) {
    if (!isUserId(first) || !isUserId(second) || first === second) throw new Error('Invalid participants');
    return `urc:private:v1:${Math.min(first, second)}:${Math.max(first, second)}`;
}

export function isMessageContent(value) {
    return typeof value === 'string' && value.trim().length > 0 && value.length <= MESSAGE_MAX_LENGTH;
}

export function publicMessage(value, first, second) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || typeof value.id !== 'string'
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.id)
        || !isUserId(value.senderId) || !isUserId(value.recipientId)
        || !((value.senderId === first && value.recipientId === second)
            || (value.senderId === second && value.recipientId === first))
        || !isMessageContent(value.content) || typeof value.createdAt !== 'string'
        || !Number.isFinite(Date.parse(value.createdAt))
        || new Date(value.createdAt).toISOString() !== value.createdAt) {
        throw new Error('Invalid private message');
    }
    return {id: value.id, senderId: value.senderId, recipientId: value.recipientId,
        content: value.content, createdAt: value.createdAt};
}

export function chronologicalMessages(messages) {
    return [...new Map(messages.map(message => [message.id, message])).values()]
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
        .slice(-MESSAGE_LIMIT);
}
