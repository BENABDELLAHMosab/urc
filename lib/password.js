import {hash, verify, Algorithm, Version} from '@node-rs/argon2';
import {createHash, randomBytes, timingSafeEqual} from 'node:crypto';
import {stringToArrayBuffer} from './base64.js';

export async function hashPassword(password) {
    const encoded = await hash(password, {
        algorithm: Algorithm.Argon2id,
        version: Version.V0x13,
        memoryCost: 19456,
        timeCost: 2,
        parallelism: 1,
        outputLen: 32,
        salt: randomBytes(16),
    });
    if (encoded.length > 100) throw new Error('Password storage format exceeds schema');
    return encoded;
}

export async function verifyPassword(username, password, encoded) {
    if (typeof encoded !== 'string') return false;
    if (encoded.startsWith('$argon2id$')) {
        try {
            return await verify(encoded, password);
        } catch {
            return false;
        }
    }
    // Compatibilité exacte avec les comptes SHA-256 historiques uniquement.
    if (!/^[A-Za-z0-9+/]{43}=$/.test(encoded)) return false;
    const legacy = createHash('sha256').update(stringToArrayBuffer(username + password)).digest();
    return timingSafeEqual(legacy, Buffer.from(encoded, 'base64'));
}
