import {getConnecterUser} from '../lib/session.js';
import {getBeamsClient} from '../lib/beams.js';

export default async function handler(request, response) {
    response.setHeader?.('Cache-Control', 'no-store');
    try {
        const user = await getConnecterUser(request);
        if (!user || !user.externalId.trim() || request.query?.user_id !== user.externalId) {
            return response.status(401).json({code: 'UNAUTHORIZED', message: 'Session ou identité invalide.'});
        }
        if ((request.method ?? 'GET') !== 'GET') {
            response.setHeader?.('Allow', 'GET');
            return response.status(405).json({code: 'METHOD_NOT_ALLOWED'});
        }
        const client = getBeamsClient();
        if (!client) return response.status(503).json({code: 'PUSH_NOT_CONFIGURED', error: 'PUSH_NOT_CONFIGURED', description: 'Notifications non configurées.'});
        // Format officiel : {token: ...}. Identité issue exclusivement de Redis.
        return response.json(client.generateToken(user.externalId));
    } catch {
        return response.status(503).json({code: 'PUSH_UNAVAILABLE'});
    }
}
