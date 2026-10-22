import {notifyPrivateMessage} from '../lib/beams.js';
import {sql} from '@vercel/postgres';
import {getConnecterUser} from '../lib/session.js';
import {isUserId, isMessageContent} from '../lib/privateMessages.js';
import {storeMessage, readMessages} from '../lib/messageStorage.js';

// Conserve la signature Node Serverless du squelette du TP.
export default async function handler(request, response) {
    response.setHeader?.('Cache-Control', 'no-store');
    const json = (body, status) => response.status(status).json(body);
    const invalid = message => json({code: 'INVALID_INPUT', message}, 400);
    let stage = 'session';
    try {
        const user = await getConnecterUser(request);
        if (!user || !isUserId(user.id)) return json({code: 'UNAUTHORIZED', message: 'Session expirée.'}, 401);
        const method = request.method ?? 'GET';
        if (method !== 'GET' && method !== 'POST') {
            response.setHeader?.('Allow', 'GET, POST');
            return json({code: 'METHOD_NOT_ALLOWED', message: 'GET ou POST requis.'}, 405);
        }

        let recipientId, content;
        if (method === 'POST') {
            let body;
            try {
                body = typeof request.body === 'string' ? JSON.parse(request.body) : request.body;
            } catch {
                return invalid('JSON invalide.');
            }
            if (!body || typeof body !== 'object' || Array.isArray(body)) return invalid('Message invalide.');
            recipientId = body.recipientId;
            content = body.content;
            if (!isMessageContent(content)) return invalid('Le message doit contenir entre 1 et 2 000 caractères, sans être vide.');
        } else {
            const value = request.query?.userId;
            if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return invalid('Destinataire invalide.');
            recipientId = Number(value);
        }
        if (!isUserId(recipientId)) return invalid('Destinataire invalide.');
        if (recipientId === user.id) return invalid('Une conversation avec soi-même est impossible.');
        stage = 'recipient_lookup';
        const {rows} = await sql`SELECT user_id, external_id FROM users WHERE user_id = ${recipientId}`;
        if (rows.length !== 1) return json({code: 'NOT_FOUND', message: 'Destinataire introuvable.'}, 404);

        if (method === 'GET') {
            stage = 'history_read';
            return json(await readMessages(user.id, recipientId), 200);
        }
        const message = {id: crypto.randomUUID(), senderId: user.id, recipientId,
            content, createdAt: new Date().toISOString()};
        stage = 'message_store';
        await storeMessage(message);
        await notifyPrivateMessage(rows[0], user.id);
        return json(message, 201);
    } catch (error) {
        // Catégories fixes uniquement : ne jamais transmettre l'exception brute aux logs.
        const detail = typeof error?.message === 'string' ? error.message : '';
        const reason = error?.code === '42703' ? 'database_column_missing'
            : error?.code === '42P01' ? 'database_table_missing'
            : /WRONGTYPE/i.test(detail) ? 'redis_wrong_type'
            : /NOPERM|NOAUTH|WRONGPASS/i.test(detail) ? 'redis_access_denied'
            : /unknown command|not supported|unsupported/i.test(detail) ? 'unsupported_command'
            : /timeout|timed out/i.test(detail) ? 'dependency_timeout'
            : 'dependency_failure';
        console.error('MESSAGES_UNAVAILABLE', {stage, reason});
        return json({code: 'MESSAGES_UNAVAILABLE', message: 'Messagerie indisponible. Veuillez réessayer.'}, 500);
    }
}
