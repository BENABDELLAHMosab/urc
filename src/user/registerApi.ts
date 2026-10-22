import type {RegistrationData} from "../../lib/registration.js";
import {CustomError} from "../model/CustomError";

export interface RegistrationResult {
    id: number;
    username: string;
}

export async function registerUser(data: RegistrationData): Promise<RegistrationResult> {
    try {
        const response = await fetch('/api/register', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(data),
        });
        if (response.status !== 201) {
            const message = response.status === 409 ? "Ce nom ou cet email est déjà utilisé."
                : response.status === 400 ? "Les informations d'inscription sont invalides."
                : "Inscription impossible. Veuillez réessayer.";
            const error = new CustomError(message);
            error.httpStatus = response.status;
            throw error;
        }
        const result = await response.json() as Partial<RegistrationResult> | null;
        if (!result || typeof result.id !== 'number' || !Number.isInteger(result.id)
            || typeof result.username !== 'string' || !result.username) {
            throw new CustomError("Réponse d'inscription invalide.");
        }
        return {id: result.id, username: result.username};
    } catch (error) {
        throw error instanceof CustomError ? error
            : new CustomError("Inscription impossible. Veuillez réessayer.");
    }
}
