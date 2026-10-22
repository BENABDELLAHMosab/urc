import React from "react";
import {useSelector} from "react-redux";
import type {RootState} from "../app/store";

export function MessagesPage() {
    const user = useSelector((state: RootState) => state.auth.user);

    return (
        <main>
            <h1>UBO Relay Chat</h1>
            {user && <p>Connecté : {user.username}</p>}
            <p>La messagerie sera développée prochainement.</p>
        </main>
    );
}
