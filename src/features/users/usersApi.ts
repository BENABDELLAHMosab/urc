// Contrat GET /api/users : noms SQL conservés, aucune donnée d'authentification.
export interface PublicUser {
    user_id: number;
    username: string;
    last_login: string | null;
}

export type UsersErrorKind = 'unauthorized' | 'network' | 'server' | 'invalid' | 'superseded';
export interface UsersFailure {
    kind: UsersErrorKind;
    message: string;
}

export class UsersApiError extends Error {
    readonly kind: UsersErrorKind;

    constructor(kind: UsersErrorKind, message: string) {
        super(message);
        this.name = 'UsersApiError';
        this.kind = kind;
    }
}

export async function getUsers(signal: AbortSignal): Promise<PublicUser[]> {
    signal.throwIfAborted();
    let token: string | null;
    try {
        token = sessionStorage.getItem('token');
    } catch {
        throw new UsersApiError('invalid', 'Accès au stockage de session impossible.');
    }
    if (!token) throw new UsersApiError('unauthorized', 'Votre session a expiré. Reconnectez-vous.');
    const assertCurrent = () => {
        signal.throwIfAborted();
        if (sessionStorage.getItem('token') !== token) {
            throw new DOMException('Session superseded', 'AbortError');
        }
    };
    let response: Response;
    try {
        response = await fetch('/api/users', {
            method: 'GET', headers: {Authorization: `Bearer ${token}`},
            cache: 'no-store', signal,
        });
    } catch {
        assertCurrent();
        throw new UsersApiError('network', 'Connexion réseau impossible. Veuillez réessayer.');
    }
    assertCurrent();
    if (response.status === 401) {
        throw new UsersApiError('unauthorized', 'Votre session a expiré. Reconnectez-vous.');
    }
    if (!response.ok) {
        throw new UsersApiError('server', 'Liste des utilisateurs indisponible. Veuillez réessayer.');
    }
    let data: unknown;
    try {
        data = await response.json();
    } catch {
        assertCurrent();
        throw new UsersApiError('invalid', 'Réponse des utilisateurs invalide.');
    }
    assertCurrent();
    if (!Array.isArray(data) || data.some(user => !user || typeof user !== 'object'
        || !Number.isSafeInteger(user.user_id) || user.user_id <= 0
        || typeof user.username !== 'string' || !user.username.trim()
        || !(user.last_login === null || (typeof user.last_login === 'string'
            && /^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/.test(user.last_login))))
        || new Set(data.map(user => user.user_id)).size !== data.length) {
        throw new UsersApiError('invalid', 'Réponse des utilisateurs invalide.');
    }
    // Sélection explicite : même une réponse contenant un champ supplémentaire ne fuit pas dans Redux.
    return data.map(({user_id, username, last_login}) => ({user_id, username, last_login}));
}
