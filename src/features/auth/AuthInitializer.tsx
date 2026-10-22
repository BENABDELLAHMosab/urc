import {useEffect} from "react";
import type {ReactNode} from "react";
import {useDispatch, useSelector, useStore} from "react-redux";
import type {RootState, AppDispatch} from "../../app/store";
import {setUser, resetAuth, sessionUnavailable} from "./authSlice";
import {verifySession} from "./sessionApi";

export function AuthInitializer({children}: {children: ReactNode}) {
    const dispatch = useDispatch<AppDispatch>();
    const reduxStore = useStore<RootState>();
    const status = useSelector((state: RootState) => state.auth.status);

    useEffect(() => {
        if (status !== "checking") return;
        const controller = new AbortController();
        const checkingState = reduxStore.getState().auth;
        const isCurrent = () => !controller.signal.aborted
            && reduxStore.getState().auth === checkingState;

        verifySession(controller.signal).then(user => {
            if (isCurrent()) dispatch(user ? setUser(user) : resetAuth());
        }).catch(error => {
            if (isCurrent() && error?.name !== "AbortError") dispatch(sessionUnavailable());
        });

        // StrictMode et les changements d'état annulent la vérification précédente.
        return () => controller.abort();
    }, [status, dispatch, reduxStore]);

    return children;
}
