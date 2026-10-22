import {db} from '@vercel/postgres';
import {Redis} from '@upstash/redis';
import {verifyPassword} from '../lib/password.js';

const redis = Redis.fromEnv();

// Runtime Node.js par défaut pour vérifier les nouveaux mots de passe Argon2id.
async function handler(request) {
    const headers = {'content-type': 'application/json', 'cache-control': 'no-store'};
    const json = (body, status) => new Response(JSON.stringify(body), {status, headers});
    if (request.method !== 'POST') {
        return new Response(JSON.stringify({code: 'METHOD_NOT_ALLOWED', message: 'POST required'}), {
            status: 405, headers: {...headers, Allow: 'POST'},
        });
    }
    let input;
    try {
        input = await request.json();
    } catch {
        return json({code: 'INVALID_INPUT', message: 'JSON invalide.'}, 400);
    }
    if (!input || typeof input.username !== 'string' || typeof input.password !== 'string'
        || !input.username || input.username.length > 50 || !input.password || input.password.length > 1024) {
        return json({code: 'INVALID_INPUT', message: 'Identifiants invalides.'}, 400);
    }
    try {
        const {username, password} = input;
        const client = await db.connect();
        try {
            const {rowCount, rows} = await client.sql`select * from users where username = ${username}`;
            if (rowCount !== 1 || !await verifyPassword(username, password, rows[0].password)) {
                return json({code: 'UNAUTHORIZED', message: 'Identifiant ou mot de passe incorrect'}, 401);
            }
            await client.sql`update users set last_login = now() where user_id = ${rows[0].user_id}`;
            const token = crypto.randomUUID().toString();
            const user = {id: rows[0].user_id, username: rows[0].username,
                email: rows[0].email, externalId: rows[0].external_id};
            await redis.set(token, user, {ex: 3600});
            const userInfo = {};
            userInfo[user.id] = user;
            await redis.hset('users', userInfo);
            return json({token, username, externalId: user.externalId, id: user.id}, 200);
        } finally {
            client.release();
        }
    } catch {
        console.error('Login request failed');
        return json({code: 'LOGIN_FAILED', message: 'Connexion impossible.'}, 500);
    }
}

export default {fetch: handler};
