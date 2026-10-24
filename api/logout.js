import {getSessionToken, redis} from '../lib/session.js';

export const config = {runtime: 'edge'};

export default async function handler(request) {
    const headers = {'content-type': 'application/json', 'cache-control': 'no-store'};
    const json = (body, status) => new Response(JSON.stringify(body), {status, headers});
    if (request.method !== 'POST') {
        return new Response(JSON.stringify({code: 'METHOD_NOT_ALLOWED', message: 'POST required'}), {
            status: 405, headers: {...headers, Allow: 'POST'},
        });
    }
    const token = getSessionToken(request);
    if (!token) return json({code: 'UNAUTHORIZED', message: 'Session expired'}, 401);
    try {
        await redis.del(token);
        return new Response(null, {status: 204, headers});
    } catch {
        return json({code: 'LOGOUT_FAILED', message: 'Déconnexion impossible. Veuillez réessayer.'}, 500);
    }
}
