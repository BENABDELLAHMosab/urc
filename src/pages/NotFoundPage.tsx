import React from "react";
import {Link} from "react-router-dom";

export function NotFoundPage() {
    return (
        <main>
            <h1>404 — Page introuvable</h1>
            <Link to="/login">Retour à la connexion</Link>
        </main>
    );
}
