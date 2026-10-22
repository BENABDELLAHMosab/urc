import React from "react";
import {AuthLayout} from '../components/AuthLayout';
import {Login} from "../user/Login";

export function LoginPage() {
    return (
        <AuthLayout title="Connexion" description="Retrouvez vos discussions et vos salons.">
            <Login />
        </AuthLayout>
    );
}
