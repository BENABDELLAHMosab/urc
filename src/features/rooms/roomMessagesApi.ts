import {chronologicalMessages, isMessageContent, isUserId, MESSAGE_LIMIT} from '../../../lib/privateMessages.js';
import {publicRoomMessage} from '../../../lib/rooms.js';
import type {RoomMessage} from '../../../lib/rooms.js';
import {requestRoomApi, RoomApiError} from './roomsApi';
export type {RoomMessage} from '../../../lib/rooms.js';

export async function fetchRoomMessages(roomId: number, signal = new AbortController().signal): Promise<RoomMessage[]> {
    if (!isUserId(roomId)) throw new RoomApiError('input', 'Identifiant de salon invalide.');
    const data = await requestRoomApi(`/api/room-messages?roomId=${roomId}`, undefined, 200, signal);
    try {
        if (!Array.isArray(data) || data.length > MESSAGE_LIMIT) throw new Error();
        return chronologicalMessages(data.map(value => publicRoomMessage(value, roomId)));
    } catch { throw new RoomApiError('invalid', 'Historique du salon invalide.'); }
}
export async function sendRoomMessage(roomId: number, content: string, signal = new AbortController().signal): Promise<RoomMessage> {
    if (!isUserId(roomId) || !isMessageContent(content)) throw new RoomApiError('input', 'Salon ou message invalide (1 à 2 000 caractères).');
    const data = await requestRoomApi('/api/room-messages', {roomId, content}, 201, signal);
    try {
        const message = publicRoomMessage(data, roomId);
        if (message.content !== content) throw new Error();
        return message;
    } catch { throw new RoomApiError('invalid', 'Réponse d’envoi invalide.'); }
}
