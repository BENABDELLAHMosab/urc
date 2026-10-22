import { sql } from "@vercel/postgres";
import {checkSession} from "../lib/session.js";

export const config = {
    runtime: 'edge',
};

export default async function handler(request) {
    const headers = {'content-type': 'application/json', 'cache-control': 'no-store'};
    const json = (body, status = 200) => new Response(JSON.stringify(body), {status, headers});
    if ((request.method ?? 'GET') !== 'GET') {
        return new Response(JSON.stringify({code: 'METHOD_NOT_ALLOWED', message: 'GET required'}), {
            status: 405, headers: {...headers, Allow: 'GET'},
        });
    }
    try {
        const connected = await checkSession(request);
        if (!connected) {
            return json({code: 'UNAUTHORIZED', message: 'Session expired'}, 401);
        }
        const {rows} = await sql`select user_id, username, TO_CHAR(last_login, 'DD/MM/YYYY HH24:MI') as last_login from users order by last_login desc`;
        return json(rows.map(({user_id, username, last_login}) => ({user_id, username, last_login})));
    } catch {
        return json({code: 'USERS_UNAVAILABLE', message: 'Liste des utilisateurs indisponible.'}, 500);
    }
};
