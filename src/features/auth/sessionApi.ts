import type {AuthUser} from "./authSlice";
import {clearStoredSession} from "../../user/loginApi";
import {CustomError} from "../../model/CustomError";

export async function logoutSession(): Promise<void> {
    const token = sessionStorage.getItem('token');
    if (!token) return;
    const response = await fetch('/api/logout', {
        method: 'POST', headers: {Authorization: `Bearer ${token}`}, cache: 'no-store',
    });
    if (!response.ok && response.status !== 401) {
        throw new CustomError("Déconnexion impossible. Veuillez réessayer.");
    }
}

export async function verifySession(signal: AbortSignal): Promise<AuthUser | null> {
    try {
        signal.throwIfAborted();
        const token = sessionStorage.getItem('token');
        if (!token) return null;

        const assertCurrent = () => {
            signal.throwIfAborted();
            if (sessionStorage.getItem('token') !== token) {
                throw new DOMException("Session verification superseded", "AbortError");
            }
        };
        const response = await fetch('/api/me', {
            method: 'GET', headers: {Authorization: `Bearer ${token}`},
            cache: 'no-store', signal,
        });
        assertCurrent();
        if (response.status === 401) {
            clearStoredSession();
            return null;
        }
        if (!response.ok) {
            const error = new CustomError("Vérification de session impossible. Veuillez réessayer.");
            error.httpStatus = response.status;
            throw error;
        }
        const user = await response.json() as Partial<AuthUser> | null;
        assertCurrent();
        if (!user || typeof user.id !== 'number' || !Number.isInteger(user.id)
            || typeof user.username !== 'string' || !user.username
            || typeof user.externalId !== 'string' || !user.externalId) {
            throw new CustomError("Réponse de session invalide.");
        }
        return {id: user.id, username: user.username, externalId: user.externalId};
    } catch (error) {
        if (signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
            throw error;
        }
        throw error instanceof CustomError ? error
            : new CustomError("Vérification de session impossible. Veuillez réessayer.");
    }
}
