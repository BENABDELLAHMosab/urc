import React, {useState} from "react";
import type {FormEvent} from "react";
import {useDispatch, useSelector} from "react-redux";
import {Link, useLocation, useNavigate} from "react-router-dom";
import type {RootState, AppDispatch} from "../app/store";
import {setUser, resetAuth} from "../features/auth/authSlice";
import {loginUser} from "./loginApi";
import type {Session} from "../model/common";
import {CustomError} from "../model/CustomError";

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
                navigate("/messages", {replace: true});
            }, (loginError: CustomError) => {
                setError(loginError);
                dispatch(resetAuth());
            });
    };

    return(<>
        <form onSubmit={handleSubmit}>
            <input name="login" placeholder="login"/><br/>
            <input name="password" type="password" placeholder="password"/><br/>
            <button type="submit">connexion</button>
        </form>
            {location.state?.registrationComplete === true &&
                <p role="status">Compte créé. Vous pouvez maintenant vous connecter.</p>
            }
            <Link to="/register">Créer un compte</Link>
            { status === "authenticated" && user &&
                <span>Connecté : {user.username}</span>
            }
            { error.message &&
                <span>{error.message}</span>
            }
        </>
    );
}
