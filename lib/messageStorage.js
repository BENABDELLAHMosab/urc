import {redis} from './session.js';
import {conversationKey, publicMessage, chronologicalMessages, MESSAGE_LIMIT, MESSAGE_TTL_SECONDS} from './privateMessages.js';
import {roomKey, publicRoomMessage} from './rooms.js';

// Un seul EVAL : aucune autre requête ne peut s'intercaler entre écriture, TTL et borne.
export const STORE_MESSAGE = `
redis.call('ZADD', KEYS[1], ARGV[2], ARGV[1])
redis.call('EXPIRE', KEYS[1], ARGV[3])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[4])
local count = redis.call('ZCARD', KEYS[1])
local maximum = tonumber(ARGV[5])
if count > maximum then redis.call('ZREMRANGEBYRANK', KEYS[1], 0, count - maximum - 1) end
return 1
`;

export const READ_MESSAGES = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
return redis.call('ZRANGE', KEYS[1], -tonumber(ARGV[2]), -1)
`;

async function storeAtKey(key, message) {
    const time = Date.parse(message.createdAt);
    const result = await redis.eval(STORE_MESSAGE, [key],
        [JSON.stringify(message), time, MESSAGE_TTL_SECONDS, time - MESSAGE_TTL_SECONDS * 1000, MESSAGE_LIMIT]);
    if (result !== 1) throw new Error('Message storage not confirmed');
}

async function readAtKey(key, validate) {
    const rows = await redis.eval(READ_MESSAGES, [key],
        [Date.now() - MESSAGE_TTL_SECONDS * 1000, MESSAGE_LIMIT]);
    if (!Array.isArray(rows) || rows.length > MESSAGE_LIMIT) throw new Error('Invalid message history');
    return chronologicalMessages(rows.map(row => validate(typeof row === 'string' ? JSON.parse(row) : row)));
}

export function storeMessage(message) {
    return storeAtKey(conversationKey(message.senderId, message.recipientId), message);
}
export function readMessages(first, second) {
    return readAtKey(conversationKey(first, second), value => publicMessage(value, first, second));
}
export function storeRoomMessage(message) {
    return storeAtKey(roomKey(message.roomId), publicRoomMessage(message, message.roomId));
}
export function readRoomMessages(roomId) {
    return readAtKey(roomKey(roomId), value => publicRoomMessage(value, roomId));
}
