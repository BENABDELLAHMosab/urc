import {sql} from '@vercel/postgres';
import {getConnecterUser} from '../lib/session.js';
import {isUserId} from '../lib/privateMessages.js';
import {normalizeRoomName, isRoomName, publicRoom} from '../lib/rooms.js';

export default async function handler(request, response) {
    response.setHeader('Cache-Control', 'no-store');
    const json = (body, status) => response.status(status).json(body);
    try {
        const user = await getConnecterUser(request);
        if (!user || !isUserId(user.id)) return json({code: 'UNAUTHORIZED', message: 'Session expirée.'}, 401);
        if (request.method === 'GET') {
            // Pas de jointure : les salons de démonstration ont un created_by sans FK.
            const {rows} = await sql`SELECT room_id, name FROM rooms ORDER BY room_id`;
            return json(rows.map(publicRoom), 200);
        }
        if (request.method !== 'POST') {
            response.setHeader('Allow', 'GET, POST');
            return json({code: 'METHOD_NOT_ALLOWED', message: 'GET ou POST requis.'}, 405);
        }
        let body;
        try { body = typeof request.body === 'string' ? JSON.parse(request.body) : request.body; }
        catch { return json({code: 'INVALID_INPUT', message: 'JSON invalide.'}, 400); }
        const name = normalizeRoomName(body?.name);
        if (!body || Array.isArray(body) || !isRoomName(name)) {
            return json({code: 'INVALID_INPUT', message: 'Le nom doit contenir 1 à 50 caractères, sans caractères de contrôle.'}, 400);
        }
        const {rows} = await sql`INSERT INTO rooms (name, created_on, created_by)
            VALUES (${name}, NOW(), ${user.id}) RETURNING room_id, name`;
        return json(publicRoom(rows[0]), 201);
    } catch (error) {
        if (error?.code === '23505') return json({code: 'CONFLICT', message: 'Ce nom de salon est déjà utilisé.'}, 409);
        return json({code: 'ROOMS_UNAVAILABLE', message: 'Salons indisponibles. Veuillez réessayer.'}, 500);
    }
}
