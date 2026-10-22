import {sql} from '@vercel/postgres';
import {randomUUID} from 'node:crypto';
import {hashPassword} from '../lib/password.js';
import {validateRegistration} from '../lib/registration.js';

// Runtime Node.js par défaut : nécessaire pour Argon2id natif.
async function handler(request) {
    const headers = {'content-type': 'application/json', 'cache-control': 'no-store'};
    const json = (body, status) => new Response(JSON.stringify(body), {status, headers});
    const conflict = () => json({code: 'CONFLICT', message: "Ce nom ou cet email est déjà utilisé."}, 409);
    if (request.method !== 'POST') {
        return new Response(JSON.stringify({code: 'METHOD_NOT_ALLOWED', message: 'POST required'}), {
            status: 405, headers: {...headers, Allow: 'POST'},
        });
    }
    let body;
    try {
        body = await request.json();
    } catch {
        return json({code: 'INVALID_INPUT', message: 'JSON invalide.'}, 400);
    }
    const validation = validateRegistration(body);
    if (validation.error) return json({code: 'INVALID_INPUT', message: validation.error}, 400);
    const {username, email, password} = validation.data;
    try {
        const existing = await sql`SELECT user_id FROM users WHERE username = ${username} OR email = ${email}`;
        if (existing.rowCount > 0) return conflict();
        const encoded = await hashPassword(password);
        const externalId = randomUUID();
        const {rows} = await sql`
            INSERT INTO users (username, password, email, created_on, external_id)
            VALUES (${username}, ${encoded}, ${email}, NOW(), ${externalId})
            RETURNING user_id, username
        `;
        return json({id: rows[0].user_id, username: rows[0].username}, 201);
    } catch (error) {
        // La contrainte SQL reste l'autorité en cas d'inscriptions concurrentes.
        if (error?.code === '23505') return conflict();
        return json({code: 'REGISTER_FAILED', message: "Inscription impossible. Veuillez réessayer."}, 500);
    }
}

export default {fetch: handler};
