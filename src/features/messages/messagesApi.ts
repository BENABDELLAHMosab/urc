import {chronologicalMessages, isMessageContent, isUserId, MESSAGE_LIMIT, publicMessage} from '../../../lib/privateMessages.js';
import type {PrivateMessage} from '../../../lib/privateMessages.js';
export type {PrivateMessage} from '../../../lib/privateMessages.js';

export interface MessagesFailure {
    kind: 'unauthorized' | 'input' | 'notFound' | 'server' | 'network' | 'invalid' | 'superseded';
    message: string;
}

export class MessagesApiError extends Error {
    readonly kind: MessagesFailure['kind'];
    constructor(kind: MessagesFailure['kind'], message: string) {
        super(message);
        this.name = 'MessagesApiError';
        this.kind = kind;
    }
}

function parseMessage(value: unknown, userId: number): PrivateMessage {
    const candidate = value as Partial<PrivateMessage> | null;
    if (!candidate || !isUserId(candidate.senderId) || !isUserId(candidate.recipientId)
        || candidate.senderId === candidate.recipientId
        || (candidate.senderId !== userId && candidate.recipientId !== userId)) throw new Error('Invalid participants');
    return publicMessage(value, candidate.senderId, candidate.recipientId);
}

async function request(userId: number, content: string | undefined, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!isUserId(userId) || (content !== undefined && !isMessageContent(content))) {
        throw new MessagesApiError('input', 'Destinataire ou contenu invalide (1 à 2 000 caractères).');
    }
    let token: string | null;
    try { token = sessionStorage.getItem('token'); }
    catch { throw new MessagesApiError('invalid', 'Accès au stockage de session impossible.'); }
    if (!token) throw new MessagesApiError('unauthorized', 'Session expirée. Reconnectez-vous.');
    const assertCurrent = () => {
        signal.throwIfAborted();
        if (sessionStorage.getItem('token') !== token) throw new DOMException('Session superseded', 'AbortError');
    };
    const sending = content !== undefined;
    let response: Response;
    try {
        response = await fetch(sending ? '/api/message' : `/api/message?userId=${userId}`, {
            method: sending ? 'POST' : 'GET', cache: 'no-store', signal,
            headers: {Authorization: `Bearer ${token}`, ...(sending ? {'Content-Type': 'application/json'} : {})},
            ...(sending ? {body: JSON.stringify({recipientId: userId, content})} : {}),
        });
    } catch {
        assertCurrent();
        throw new MessagesApiError('network', 'Connexion réseau impossible. Veuillez réessayer.');
    }
    assertCurrent();
    if (response.status === 401) throw new MessagesApiError('unauthorized', 'Session expirée. Reconnectez-vous.');
    if (response.status === 400) throw new MessagesApiError('input', 'Message ou destinataire invalide.');
    if (response.status === 404) throw new MessagesApiError('notFound', 'Ce destinataire n’existe plus.');
    if (!response.ok) throw new MessagesApiError('server', 'Messagerie indisponible. Veuillez réessayer.');
    if (response.status !== (sending ? 201 : 200)) throw new MessagesApiError('invalid', 'Réponse de messagerie invalide.');
    let result: PrivateMessage | PrivateMessage[];
    try {
        const data: unknown = await response.json();
        assertCurrent();
        if (sending) {
            const message = parseMessage(data, userId);
            if (message.recipientId !== userId || message.content !== content) throw new Error('Invalid sent message');
            result = message;
        } else {
            if (!Array.isArray(data) || data.length > MESSAGE_LIMIT) throw new Error('Invalid history');
            const messages = data.map(value => parseMessage(value, userId));
            const other = (message: PrivateMessage) => message.senderId === userId ? message.recipientId : message.senderId;
            if (messages.some(message => other(message) !== other(messages[0]))) throw new Error('Mixed conversations');
            result = chronologicalMessages(messages);
        }
    } catch {
        assertCurrent();
        throw new MessagesApiError('invalid', 'Réponse de messagerie invalide.');
    }
    assertCurrent();
    return result;
}

export async function fetchMessages(userId: number, signal = new AbortController().signal): Promise<PrivateMessage[]> {
    return await request(userId, undefined, signal) as PrivateMessage[];
}

export async function sendMessage(recipientId: number, content: string, signal = new AbortController().signal): Promise<PrivateMessage> {
    if (!isMessageContent(content)) throw new MessagesApiError('input', 'Le message doit contenir entre 1 et 2 000 caractères, sans être vide.');
    return await request(recipientId, content, signal) as PrivateMessage;
}
