import {createAsyncThunk, createSlice} from '@reduxjs/toolkit';
import type {PayloadAction} from '@reduxjs/toolkit';
import type {RootState} from '../../app/store';
import {resetAuth, sessionUnavailable, setUser, startChecking} from '../auth/authSlice';
import {clearStoredSession} from '../../user/loginApi';
import * as api from './messagesApi';
import type {MessagesFailure, PrivateMessage} from './messagesApi';
import {chronologicalMessages, isUserId, publicMessage} from '../../../lib/privateMessages.js';

type Status = 'idle' | 'loading' | 'succeeded' | 'failed';
export interface MessagesState {
    userId: number | null;
    items: PrivateMessage[];
    hasLoaded: boolean;
    readStatus: Status;
    sendStatus: Status;
    readError: string | null;
    sendError: string | null;
    readRequestId: string | null;
    sendRequestId: string | null;
    confirmedDuringFetch: PrivateMessage[];
}
const initialState: MessagesState = {userId: null, items: [], hasLoaded: false, readStatus: 'idle', sendStatus: 'idle',
    readError: null, sendError: null, readRequestId: null, sendRequestId: null, confirmedDuringFetch: []};
type ThunkConfig = {state: RootState; rejectValue: MessagesFailure};

// Aucun token dans les arguments des thunks ou dans leurs actions.
export const fetchMessages = createAsyncThunk<PrivateMessage[], number, ThunkConfig>(
    'messages/fetch', async (userId, {getState, dispatch, signal, requestId, rejectWithValue}) => {
        const auth = getState().auth;
        const current = () => !signal.aborted && getState().auth === auth
            && getState().messages.userId === userId && getState().messages.readRequestId === requestId;
        try {
            const messages = await api.fetchMessages(userId, signal);
            if (!current()) return rejectWithValue({kind: 'superseded', message: 'Requête remplacée.'});
            return messages.map(message => publicMessage(message, auth.user!.id, userId));
        } catch (error) {
            if (!current()) return rejectWithValue({kind: 'superseded', message: 'Requête remplacée.'});
            if (error instanceof DOMException && error.name === 'AbortError') throw error;
            if (error instanceof api.MessagesApiError) {
                if (error.kind === 'unauthorized') { clearStoredSession(); dispatch(resetAuth()); }
                return rejectWithValue({kind: error.kind, message: error.message});
            }
            return rejectWithValue({kind: 'invalid', message: 'Historique invalide. Veuillez réessayer.'});
        }
    }, {condition: (userId, {getState}) => getState().auth.status === 'authenticated'
        && isUserId(userId) && userId !== getState().auth.user?.id && getState().messages.userId === userId},
);

export const sendMessage = createAsyncThunk<PrivateMessage, {recipientId: number; content: string}, ThunkConfig>(
    'messages/send', async ({recipientId, content}, {getState, dispatch, signal, requestId, rejectWithValue}) => {
        const auth = getState().auth;
        const current = () => !signal.aborted && getState().auth === auth
            && getState().messages.userId === recipientId && getState().messages.sendRequestId === requestId;
        try {
            const message = await api.sendMessage(recipientId, content, signal);
            if (!current()) return rejectWithValue({kind: 'superseded', message: 'Requête remplacée.'});
            return publicMessage(message, auth.user!.id, recipientId);
        } catch (error) {
            if (!current()) return rejectWithValue({kind: 'superseded', message: 'Requête remplacée.'});
            if (error instanceof DOMException && error.name === 'AbortError') throw error;
            if (error instanceof api.MessagesApiError) {
                if (error.kind === 'unauthorized') { clearStoredSession(); dispatch(resetAuth()); }
                return rejectWithValue({kind: error.kind, message: error.message});
            }
            return rejectWithValue({kind: 'invalid', message: 'Envoi impossible. Veuillez réessayer.'});
        }
    }, {condition: ({recipientId}, {getState}) => getState().auth.status === 'authenticated'
        && isUserId(recipientId) && recipientId !== getState().auth.user?.id
        && getState().messages.userId === recipientId && getState().messages.sendStatus !== 'loading'},
);

const messagesSlice = createSlice({
    name: 'messages', initialState,
    reducers: {
        openConversation: (_, action: PayloadAction<number>) => ({...initialState, userId: action.payload}),
        clearMessages: () => initialState,
    },
    extraReducers: builder => { builder
        .addCase(fetchMessages.pending, (state, action) => {
            state.readStatus = 'loading'; state.readError = null;
            state.readRequestId = action.meta.requestId; state.confirmedDuringFetch = [];
        })
        .addCase(fetchMessages.fulfilled, (state, action) => {
            if (state.readRequestId !== action.meta.requestId) return;
            state.items = chronologicalMessages([...action.payload, ...state.confirmedDuringFetch]);
            state.hasLoaded = true;
            state.confirmedDuringFetch = []; state.readRequestId = null; state.readStatus = 'succeeded';
        })
        .addCase(fetchMessages.rejected, (state, action) => {
            if (state.readRequestId !== action.meta.requestId) return;
            state.readRequestId = null; state.confirmedDuringFetch = [];
            const cancelled = action.meta.aborted || action.payload?.kind === 'superseded';
            state.readStatus = cancelled ? 'idle' : 'failed';
            state.readError = cancelled ? null : action.payload?.message ?? 'Chargement impossible.';
        })
        .addCase(sendMessage.pending, (state, action) => {
            state.sendStatus = 'loading'; state.sendError = null; state.sendRequestId = action.meta.requestId;
        })
        .addCase(sendMessage.fulfilled, (state, action) => {
            if (state.sendRequestId !== action.meta.requestId) return;
            state.items = chronologicalMessages([...state.items, action.payload]);
            if (state.readStatus === 'loading') state.confirmedDuringFetch = chronologicalMessages([...state.confirmedDuringFetch, action.payload]);
            state.sendRequestId = null; state.sendStatus = 'succeeded';
        })
        .addCase(sendMessage.rejected, (state, action) => {
            if (state.sendRequestId !== action.meta.requestId) return;
            state.sendRequestId = null;
            const cancelled = action.meta.aborted || action.payload?.kind === 'superseded';
            state.sendStatus = cancelled ? 'idle' : 'failed';
            state.sendError = cancelled ? null : action.payload?.message ?? 'Envoi impossible.';
        })
        .addCase(resetAuth, () => initialState).addCase(setUser, () => initialState)
        .addCase(startChecking, () => initialState).addCase(sessionUnavailable, () => initialState);
    },
});
export const {openConversation, clearMessages} = messagesSlice.actions;
export default messagesSlice.reducer;
