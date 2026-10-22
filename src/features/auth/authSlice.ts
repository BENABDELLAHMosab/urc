import {createSlice} from "@reduxjs/toolkit";
import type {PayloadAction} from "@reduxjs/toolkit";

export interface AuthUser {
    id: number;
    username: string;
    externalId: string;
}

interface AuthState {
    user: AuthUser | null;
    status: "anonymous" | "authenticated";
}

const initialState: AuthState = {
    user: null,
    status: "anonymous",
};

const authSlice = createSlice({
    name: "auth",
    initialState,
    reducers: {
        setUser(state, action: PayloadAction<AuthUser>) {
            state.user = action.payload;
            state.status = "authenticated";
        },
        resetAuth() {
            return initialState;
        },
    },
});

export const {setUser, resetAuth} = authSlice.actions;
export default authSlice.reducer;
