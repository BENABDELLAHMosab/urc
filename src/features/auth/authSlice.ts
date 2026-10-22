import {createSlice} from "@reduxjs/toolkit";
import type {PayloadAction} from "@reduxjs/toolkit";

export interface AuthUser {
    id: number;
    username: string;
    externalId: string;
}

interface AuthState {
    user: AuthUser | null;
    status: "checking" | "authenticated" | "anonymous" | "unavailable";
    error: string | null;
}

const initialState: AuthState = {
    user: null,
    status: "checking",
    error: null,
};

const authSlice = createSlice({
    name: "auth",
    initialState,
    reducers: {
        setUser(state, action: PayloadAction<AuthUser>) {
            state.user = action.payload;
            state.status = "authenticated";
            state.error = null;
        },
        resetAuth() {
            return {...initialState, status: "anonymous"};
        },
        startChecking() {
            return initialState;
        },
        sessionUnavailable(state) {
            state.user = null;
            state.status = "unavailable";
            state.error = "Vérification de session impossible. Veuillez réessayer.";
        },
    },
});

export const {setUser, resetAuth, startChecking, sessionUnavailable} = authSlice.actions;
export default authSlice.reducer;
