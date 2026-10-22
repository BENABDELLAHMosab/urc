import {getConnecterUser} from "../lib/session";

export const config = {runtime: 'edge'};

export default async function handler(request) {
    const headers = {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        'vary': 'Authorization',
    };
    const json = (body, status) => new Response(JSON.stringify(body), {status, headers});

    if (request.method !== 'GET') {
        return new Response(JSON.stringify({code: 'METHOD_NOT_ALLOWED', message: 'GET required'}), {
            status: 405, headers: {...headers, Allow: 'GET'},
        });
    }
    try {
        const user = await getConnecterUser(request);
        if (!user) {
            return json({code: 'UNAUTHORIZED', message: 'Session expired'}, 401);
        }
        return json({id: user.id, username: user.username, externalId: user.externalId}, 200);
    } catch {
        return json({code: 'SESSION_UNAVAILABLE', message: 'Session verification unavailable'}, 500);
    }
}
