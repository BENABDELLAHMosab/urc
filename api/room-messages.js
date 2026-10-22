import {sql} from '@vercel/postgres';
import {getConnecterUser} from '../lib/session.js';
import {isUserId, isMessageContent} from '../lib/privateMessages.js';
import {readRoomMessages, storeRoomMessage} from '../lib/messageStorage.js';

export default async function handler(request, response) {
    response.setHeader('Cache-Control', 'no-store');
    const json = (body, status) => response.status(status).json(body);
    const invalid = message => json({code: 'INVALID_INPUT', message}, 400);
    try {
        const user = await getConnecterUser(request);
        if (!user || !isUserId(user.id) || !user.username.trim() || user.username.length > 50) {
            return json({code: 'UNAUTHORIZED', message: 'Session expirée.'}, 401);
        }
        if (!['GET', 'POST'].includes(request.method)) {
            response.setHeader('Allow', 'GET, POST');
            return json({code: 'METHOD_NOT_ALLOWED', message: 'GET ou POST requis.'}, 405);
        }
        let roomId, content;
        if (request.method === 'POST') {
            let body;
            try { body = typeof request.body === 'string' ? JSON.parse(request.body) : request.body; }
            catch { return invalid('JSON invalide.'); }
            if (!body || typeof body !== 'object' || Array.isArray(body)) return invalid('Message invalide.');
            roomId = body.roomId; content = body.content;
            if (!isMessageContent(content)) return invalid('Le message doit contenir 1 à 2 000 caractères, sans être vide.');
        } else {
            const value = request.query?.roomId;
            if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return invalid('Identifiant de salon invalide.');
            roomId = Number(value);
        }
        if (!isUserId(roomId)) return invalid('Identifiant de salon invalide.');
        const {rows} = await sql`SELECT room_id FROM rooms WHERE room_id = ${roomId}`;
        if (rows.length !== 1) return json({code: 'NOT_FOUND', message: 'Salon introuvable.'}, 404);
        if (request.method === 'GET') return json(await readRoomMessages(roomId), 200);
        const message = {id: crypto.randomUUID(), roomId, senderId: user.id, senderName: user.username,
            content, createdAt: new Date().toISOString()};
        await storeRoomMessage(message);
        return json(message, 201);
    } catch {
        return json({code: 'MESSAGES_UNAVAILABLE', message: 'Messages du salon indisponibles. Veuillez réessayer.'}, 500);
    }
}
