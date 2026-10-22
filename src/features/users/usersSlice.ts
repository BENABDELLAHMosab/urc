import {createAsyncThunk, createSlice} from '@reduxjs/toolkit';
import type {RootState} from '../../app/store';
import {resetAuth, sessionUnavailable, setUser, startChecking} from '../auth/authSlice';
import {clearStoredSession} from '../../user/loginApi';
import {getUsers, UsersApiError} from './usersApi';
import type {PublicUser, UsersFailure} from './usersApi';

export interface UsersState {
    items: PublicUser[];
    status: 'idle' | 'loading' | 'succeeded' | 'failed';
    error: string | null;
    requestId: string | null;
}

const initialState: UsersState = {items: [], status: 'idle', error: null, requestId: null};

export const fetchUsers = createAsyncThunk<PublicUser[], void,
    {state: RootState; rejectValue: UsersFailure}>(
    'users/fetchUsers',
    async (_, {getState, dispatch, signal, requestId, rejectWithValue}) => {
        const auth = getState().auth;
        const isCurrent = () => !signal.aborted && getState().auth === auth
            && getState().users.requestId === requestId;
        try {
            const users = await getUsers(signal);
            if (!isCurrent()) return rejectWithValue({kind: 'superseded', message: 'Requête remplacée.'});
            return users;
        } catch (error) {
            if (!isCurrent()) return rejectWithValue({kind: 'superseded', message: 'Requête remplacée.'});
            if (error instanceof UsersApiError) {
                if (error.kind === 'unauthorized') {
                    clearStoredSession();
                    dispatch(resetAuth());
                }
                return rejectWithValue({kind: error.kind, message: error.message});
            }
            if (error instanceof DOMException && error.name === 'AbortError') throw error;
            return rejectWithValue({kind: 'invalid', message: 'Chargement impossible. Veuillez réessayer.'});
        }
    },
    {condition: (_, {getState}) => getState().auth.status === 'authenticated'},
);

const usersSlice = createSlice({
    name: 'users',
    initialState,
    reducers: {},
    extraReducers: builder => {
        builder
            .addCase(fetchUsers.pending, (state, action) => {
                state.items = [];
                state.status = 'loading';
                state.error = null;
                state.requestId = action.meta.requestId;
            })
            .addCase(fetchUsers.fulfilled, (state, action) => {
                if (state.requestId !== action.meta.requestId) return;
                state.items = action.payload;
                state.status = 'succeeded';
                state.requestId = null;
            })
            .addCase(fetchUsers.rejected, (state, action) => {
                if (state.requestId !== action.meta.requestId) return;
                state.items = [];
                state.requestId = null;
                if (action.meta.aborted || action.payload?.kind === 'superseded') {
                    state.status = 'idle';
                    state.error = null;
                } else {
                    state.status = 'failed';
                    state.error = action.payload?.message ?? 'Chargement impossible. Veuillez réessayer.';
                }
            })
            // Ces actions invalident aussi toute réponse encore en vol.
            .addCase(resetAuth, () => initialState)
            .addCase(setUser, () => initialState)
            .addCase(startChecking, () => initialState)
            .addCase(sessionUnavailable, () => initialState);
    },
});

export default usersSlice.reducer;
