import React from "react";
import {AuthLayout} from '../components/AuthLayout';
import {Link} from "react-router-dom";

export function NotFoundPage() {
    return (
        <AuthLayout title="404 — Page introuvable" description="Cette adresse ne correspond à aucune page de l’application.">
            <Link to="/login">Retour à la connexion</Link>
        </AuthLayout>
    );
}
