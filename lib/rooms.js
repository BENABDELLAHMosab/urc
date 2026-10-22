import {isUserId, isMessageContent} from './privateMessages.js';

export function normalizeRoomName(value) {
    return typeof value === 'string' ? value.trim() : '';
}

export function isRoomName(value) {
    return typeof value === 'string' && value === value.trim() && value.length >= 1
        && value.length <= 50 && !/[\u0000-\u001f\u007f]/.test(value);
}

export function publicRoom(value) {
    if (!value || typeof value !== 'object' || !isUserId(value.room_id) || !isRoomName(value.name)) {
        throw new Error('Invalid room');
    }
    return {room_id: value.room_id, name: value.name};
}

export function roomKey(roomId) {
    if (!isUserId(roomId)) throw new Error('Invalid room ID');
    return `urc:room:v1:${roomId}`;
}

export function publicRoomMessage(value, roomId) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || typeof value.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.id)
        || !isUserId(value.roomId) || value.roomId !== roomId || !isUserId(value.senderId)
        || typeof value.senderName !== 'string' || !value.senderName.trim() || value.senderName.length > 50
        || !isMessageContent(value.content) || typeof value.createdAt !== 'string'
        || !Number.isFinite(Date.parse(value.createdAt)) || new Date(value.createdAt).toISOString() !== value.createdAt) {
        throw new Error('Invalid room message');
    }
    return {id: value.id, roomId: value.roomId, senderId: value.senderId, senderName: value.senderName,
        content: value.content, createdAt: value.createdAt};
}
