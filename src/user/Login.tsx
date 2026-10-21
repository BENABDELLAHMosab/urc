import React, {useState} from "react";
import type {FormEvent} from "react";
import {loginUser} from "./loginApi";
import type {Session} from "../model/common";
import {CustomError} from "../model/CustomError";

export function Login() {

    const [error, setError] = useState({} as CustomError);
    const [session, setSession] = useState({} as Session);

    const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const form = event.currentTarget;
        const data = new FormData(form);
        loginUser({user_id: -1, username:  data.get('login') as string, password: data.get('password') as string},
            (result: Session) => {
                setSession(result);
                form.reset();
                setError(new CustomError(""));
            }, (loginError: CustomError) => {
                setError(loginError);
                setSession({} as Session);
            });
    };

    return(<>
        <form onSubmit={handleSubmit}>
            <input name="login" placeholder="login"/><br/>
            <input name="password" type="password" placeholder="password"/><br/>
            <button type="submit">connexion</button>
        </form>
            { session.token &&
                <span>Connecté : {session.username}</span>
            }
            { error.message &&
                <span>{error.message}</span>
            }
        </>
    );
}
