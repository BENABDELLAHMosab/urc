import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

export async function getConnecterUser(request) {
    const authorization = new Headers(request.headers).get('Authorization');
    // Les sessions créées par /api/login utilisent crypto.randomUUID() (UUID v4).
    const match = authorization?.match(/^Bearer ([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i);
    if (!match) {
        return null;
    }

    const user = await redis.get(match[1]);
    if (!user || typeof user !== "object" || Array.isArray(user)
        || !Number.isInteger(user.id) || typeof user.username !== "string"
        || typeof user.externalId !== "string") {
        return null;
    }
    return user;
}

export async function checkSession(request) {
    return (await getConnecterUser(request)) !== null;
}

export function unauthorizedResponse() {
    const error = {code: "UNAUTHORIZED", message: "Session expired"};
    return new Response(JSON.stringify(error), {
        status: 401,
        headers: {'content-type': 'application/json'},
    });
}

export function triggerNotConnected(res) {
    return res.status(401).json({code: "UNAUTHORIZED", message: "Session expired"});
}
