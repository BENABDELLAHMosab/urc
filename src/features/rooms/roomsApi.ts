import {isRoomName, normalizeRoomName, publicRoom} from '../../../lib/rooms.js';
import type {Room} from '../../../lib/rooms.js';
export type {Room} from '../../../lib/rooms.js';

export interface RoomFailure {
    kind: 'unauthorized' | 'input' | 'notFound' | 'conflict' | 'server' | 'network' | 'invalid' | 'superseded';
    message: string;
}
export class RoomApiError extends Error {
    readonly kind: RoomFailure['kind'];
    constructor(kind: RoomFailure['kind'], message: string) {
        super(message); this.name = 'RoomApiError'; this.kind = kind;
    }
}

// Transport commun aux salons et à leurs messages, sans importer le store.
export async function requestRoomApi(url: string, body: unknown | undefined, expected: number, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    let token: string | null;
    try { token = sessionStorage.getItem('token'); }
    catch { throw new RoomApiError('invalid', 'Accès au stockage de session impossible.'); }
    if (!token) throw new RoomApiError('unauthorized', 'Session expirée. Reconnectez-vous.');
    const current = () => {
        signal.throwIfAborted();
        if (sessionStorage.getItem('token') !== token) throw new DOMException('Session superseded', 'AbortError');
    };
    let response: Response;
    try {
        response = await fetch(url, {method: body === undefined ? 'GET' : 'POST', signal, cache: 'no-store',
            headers: {Authorization: `Bearer ${token}`, ...(body === undefined ? {} : {'Content-Type': 'application/json'})},
            ...(body === undefined ? {} : {body: JSON.stringify(body)})});
    } catch {
        current(); throw new RoomApiError('network', 'Connexion réseau impossible. Veuillez réessayer.');
    }
    current();
    if (response.status === 401) throw new RoomApiError('unauthorized', 'Session expirée. Reconnectez-vous.');
    if (response.status === 400) throw new RoomApiError('input', 'Nom de salon ou message invalide.');
    if (response.status === 404) throw new RoomApiError('notFound', 'Salon introuvable.');
    if (response.status === 409) throw new RoomApiError('conflict', 'Ce nom de salon est déjà utilisé.');
    if (!response.ok) throw new RoomApiError('server', 'Service des salons indisponible. Veuillez réessayer.');
    if (response.status !== expected) throw new RoomApiError('invalid', 'Réponse des salons invalide.');
    try {
        const data: unknown = await response.json(); current(); return data;
    } catch {
        current(); throw new RoomApiError('invalid', 'Réponse des salons invalide.');
    }
}

export async function getRooms(signal = new AbortController().signal): Promise<Room[]> {
    const data = await requestRoomApi('/api/rooms', undefined, 200, signal);
    try {
        if (!Array.isArray(data)) throw new Error();
        const rooms = data.map(publicRoom);
        if (new Set(rooms.map(room => room.room_id)).size !== rooms.length) throw new Error();
        return rooms;
    } catch { throw new RoomApiError('invalid', 'Liste des salons invalide.'); }
}
export async function postRoom(value: string, signal = new AbortController().signal): Promise<Room> {
    const name = normalizeRoomName(value);
    if (!isRoomName(name)) throw new RoomApiError('input', 'Le nom doit contenir 1 à 50 caractères, sans caractères de contrôle.');
    const data = await requestRoomApi('/api/rooms', {name}, 201, signal);
    try { return publicRoom(data); }
    catch { throw new RoomApiError('invalid', 'Réponse de création invalide.'); }
}
