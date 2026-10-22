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
        return <p role="status">Vérification de la session…</p>;
    }
    if (status === "unavailable") {
        return (
            <div role="alert">
                <p>{error}</p>
                <button onClick={() => dispatch(startChecking())}>Réessayer</button>
            </div>
        );
    }
    if (status === "authenticated" && user) return <Outlet />;
    return <Navigate to="/login" replace state={{returnTo: location.pathname}} />;
}
