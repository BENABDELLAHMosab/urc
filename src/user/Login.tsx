import React, {useState} from "react";
import type {FormEvent} from "react";
import {useDispatch, useSelector} from "react-redux";
import {Link, useLocation, useNavigate} from "react-router-dom";
import type {RootState, AppDispatch} from "../app/store";
import {setUser, resetAuth} from "../features/auth/authSlice";
import {loginUser} from "./loginApi";
import type {Session} from "../model/common";
import {CustomError} from "../model/CustomError";
import {PasswordInput} from '../components/PasswordInput';

export function Login() {

    const [error, setError] = useState({} as CustomError);
    const dispatch = useDispatch<AppDispatch>();
    const navigate = useNavigate();
    const location = useLocation();
    const {user, status} = useSelector((state: RootState) => state.auth);

    const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const form = event.currentTarget;
        const data = new FormData(form);
        return loginUser({user_id: -1, username:  data.get('login') as string, password: data.get('password') as string},
            (result: Session) => {
                if (result.id === undefined || !result.username) {
                    throw new CustomError("Réponse de connexion invalide.");
                }
                // Ne transmettre à Redux que les informations publiques.
                dispatch(setUser({
                    id: result.id,
                    username: result.username,
                    externalId: result.externalId,
                }));
                form.reset();
                setError(new CustomError(""));
                const returnTo = location.state?.returnTo;
                const id = typeof returnTo === 'string' ? Number(returnTo.slice('/messages/user/'.length)) : NaN;
                const destination = typeof returnTo === 'string' && /^\/messages\/user\/[1-9]\d*$/.test(returnTo)
                    && Number.isSafeInteger(id) && id <= 2147483647 ? returnTo : '/messages';
                navigate(destination, {replace: true});
            }, (loginError: CustomError) => {
                setError(loginError);
                dispatch(resetAuth());
            });
    };

    return(<>
        <form className="auth-form" onSubmit={handleSubmit}>
            <label htmlFor="login-username">Nom d’utilisateur</label>
            <input id="login-username" name="login" autoComplete="username" placeholder="Votre nom d’utilisateur" aria-invalid={!!error.message} aria-describedby={error.message ? "login-error" : undefined} />
            <label htmlFor="login-password">Mot de passe</label>
            <PasswordInput id="login-password" name="password" autoComplete="current-password" aria-invalid={!!error.message} placeholder="Votre mot de passe" aria-describedby={error.message ? "login-error" : undefined} />
            { error.message &&
                <p id="login-error" role="alert">{error.message}</p>
            }
            <button className="button-primary" type="submit">Se connecter</button>
        </form>
            {location.state?.registrationComplete === true &&
                <p role="status">Compte créé. Vous pouvez maintenant vous connecter.</p>
            }
            <Link className="auth-switch" to="/register">Créer un compte</Link>
            { status === "authenticated" && user &&
                <span className="auth-session">Connecté : {user.username}</span>
            }
        </>
    );
}
