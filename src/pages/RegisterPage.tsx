import React, {useState} from "react";
import type {FormEvent} from "react";
import {Link, useNavigate} from "react-router-dom";
import {validateRegistration} from "../../lib/registration.js";
import type {RegistrationFieldErrors} from "../../lib/registration.js";
import {registerUser} from "../user/registerApi";
import {AuthLayout} from '../components/AuthLayout';
import {CustomError} from "../model/CustomError";

export function RegisterPage() {
    const [username, setUsername] = useState('');
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const [pending, setPending] = useState(false);
    const [fieldErrors, setFieldErrors] = useState<RegistrationFieldErrors>({});
    const navigate = useNavigate();

    const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (pending) return;
        setError('');
        setFieldErrors({});
        const validation = validateRegistration({username, email, password});
        if (!validation.data) {
            setFieldErrors(validation.fieldErrors ?? {});
            if (!validation.fieldErrors) setError(validation.error);
            return;
        }
        setPending(true);
        try {
            await registerUser(validation.data);
            setPassword('');
            navigate('/login', {replace: true, state: {registrationComplete: true}});
        } catch (failure) {
            setError(failure instanceof CustomError ? failure.message
                : "Inscription impossible. Veuillez réessayer.");
        } finally {
            setPending(false);
        }
    };

    return (
        <AuthLayout title="Inscription" description="Créez votre compte pour rejoindre les échanges.">
            <form className="auth-form" onSubmit={handleSubmit} aria-busy={pending} noValidate>
                <label htmlFor="register-username">Nom d'utilisateur</label>
                <input id="register-username" name="username" autoComplete="username" required
                    minLength={3} maxLength={50} pattern="[A-Za-z0-9_.\-]{3,50}"
                    aria-invalid={!!fieldErrors.username} aria-describedby="register-username-error"
                    value={username} onChange={event => setUsername(event.target.value)} disabled={pending} />
                {fieldErrors.username && <p id="register-username-error" role="alert">{fieldErrors.username}</p>}
                <label htmlFor="register-email">Email</label>
                <input id="register-email" name="email" type="email" autoComplete="email" required
                    aria-invalid={!!fieldErrors.email} aria-describedby="register-email-error"
                    maxLength={255} value={email} onChange={event => setEmail(event.target.value)} disabled={pending} />
                {fieldErrors.email && <p id="register-email-error" role="alert">{fieldErrors.email}</p>}
                <label htmlFor="register-password">Mot de passe</label>
                <input id="register-password" name="password" type="password" autoComplete="new-password" required
                    minLength={12} maxLength={128} value={password}
                    aria-invalid={!!fieldErrors.password} aria-describedby="register-password-help register-password-error"
                    onChange={event => setPassword(event.target.value)} disabled={pending} />
                <p id="register-password-help">12 à 128 caractères pour le mot de passe.</p>
                {fieldErrors.password && <p id="register-password-error" role="alert">{fieldErrors.password}</p>}
                <button className="button-primary" type="submit" disabled={pending}>{pending ? 'Inscription en cours…' : "S'inscrire"}</button>
            </form>
            {pending && <p role="status">Inscription en cours…</p>}
            {error && <p role="alert">{error}</p>}
            <Link className="auth-switch" to="/login">Retour à la connexion</Link>
        </AuthLayout>
    );
}
