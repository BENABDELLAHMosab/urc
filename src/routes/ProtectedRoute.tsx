import React from "react";
import {useDispatch, useSelector} from "react-redux";
import {Navigate, Outlet, useLocation} from "react-router-dom";
import type {RootState, AppDispatch} from "../app/store";
import {startChecking} from "../features/auth/authSlice";

export function ProtectedRoute() {
    const {status, user, error} = useSelector((state: RootState) => state.auth);
    const location = useLocation();
    const dispatch = useDispatch<AppDispatch>();

    if (status === "checking") {
        return <main className="route-state"><p role="status">Vérification de la session…</p></main>;
    }
    if (status === "unavailable") {
        return (
            <main className="route-state" role="alert">
                <p>{error}</p>
                <button onClick={() => dispatch(startChecking())}>Réessayer</button>
            </main>
        );
    }
    if (status === "authenticated" && user) return <Outlet />;
    return <Navigate to="/login" replace state={{returnTo: location.pathname}} />;
}
