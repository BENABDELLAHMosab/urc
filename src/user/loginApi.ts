import type {Session, SessionCallback, ErrorCallback, User} from "../model/common";
import {CustomError} from "../model/CustomError";

function clearStoredSession() {
    for (const key of ['token', 'externalId', 'username']) {
        try {
            sessionStorage.removeItem(key);
        } catch {
            // Continuer le nettoyage si le navigateur refuse un accès au stockage.
        }
    }
}

export async function loginUser(user: User, onResult: SessionCallback, onError: ErrorCallback) {
    try {
        const response = await fetch("/api/login", {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify(user),
        });

        if (!response.ok) {
            const error = new CustomError(response.status === 401
                ? "Identifiant ou mot de passe incorrect"
                : "Connexion impossible. Veuillez réessayer.");
            error.httpStatus = response.status;
            if (response.status === 401) {
                error.code = "UNAUTHORIZED";
            }
            throw error;
        }

        const session = await response.json() as Partial<Session> | null;
        if (!session || typeof session.token !== "string" || !session.token.trim()
            || typeof session.externalId !== "string" || !session.externalId.trim()
            || (session.username !== undefined && typeof session.username !== "string")
            || (session.id !== undefined && !Number.isInteger(session.id))) {
            throw new CustomError("Réponse de connexion invalide.");
        }

        sessionStorage.setItem('externalId', session.externalId);
        sessionStorage.setItem('username', session.username || "");
        // Écrire le token en dernier ; toute erreur déclenche le nettoyage ci-dessous.
        sessionStorage.setItem('token', session.token);
        onResult(session as Session);
    } catch (error) {
        clearStoredSession();
        onError(error instanceof CustomError
            ? error
            : new CustomError("Connexion impossible. Veuillez réessayer."));
    }
}
