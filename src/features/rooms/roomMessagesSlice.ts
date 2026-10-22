import {createAsyncThunk, createSlice} from '@reduxjs/toolkit';
import type {PayloadAction} from '@reduxjs/toolkit';
import type {RootState} from '../../app/store';
import {resetAuth, sessionUnavailable, setUser, startChecking} from '../auth/authSlice';
import {clearStoredSession} from '../../user/loginApi';
import * as api from './roomMessagesApi';
import type {RoomMessage} from './roomMessagesApi';
import {RoomApiError} from './roomsApi';
import type {RoomFailure} from './roomsApi';
import {chronologicalMessages, isUserId} from '../../../lib/privateMessages.js';
import {publicRoomMessage} from '../../../lib/rooms.js';

type Status = 'idle' | 'loading' | 'succeeded' | 'failed';
export interface RoomMessagesState {
    roomId: number | null;
    items: RoomMessage[];
    hasLoaded: boolean;
    readStatus: Status;
    sendStatus: Status;
    readError: string | null;
    sendError: string | null;
    readRequestId: string | null;
    sendRequestId: string | null;
    confirmedDuringFetch: RoomMessage[];
}
const initialState: RoomMessagesState = {roomId: null, items: [], hasLoaded: false, readStatus: 'idle', sendStatus: 'idle',
    readError: null, sendError: null, readRequestId: null, sendRequestId: null, confirmedDuringFetch: []};
type ThunkConfig = {state: RootState; rejectValue: RoomFailure};

// Aucun token dans les arguments des thunks ou dans leurs actions.
export const fetchRoomMessages = createAsyncThunk<RoomMessage[], number, ThunkConfig>(
    'roomMessages/fetch', async (roomId, {getState, dispatch, signal, requestId, rejectWithValue}) => {
        const auth = getState().auth;
        const current = () => !signal.aborted && getState().auth === auth
            && getState().roomMessages.roomId === roomId && getState().roomMessages.readRequestId === requestId;
        try {
            const messages = await api.fetchRoomMessages(roomId, signal);
            if (!current()) return rejectWithValue({kind: 'superseded', message: 'Requête remplacée.'});
            return messages.map(message => publicRoomMessage(message, roomId));
        } catch (error) {
            if (!current()) return rejectWithValue({kind: 'superseded', message: 'Requête remplacée.'});
            if (error instanceof DOMException && error.name === 'AbortError') throw error;
            if (error instanceof RoomApiError) {
                if (error.kind === 'unauthorized') { clearStoredSession(); dispatch(resetAuth()); }
                return rejectWithValue({kind: error.kind, message: error.message});
            }
            return rejectWithValue({kind: 'invalid', message: 'Historique invalide. Veuillez réessayer.'});
        }
    }, {condition: (roomId, {getState}) => getState().auth.status === 'authenticated'
        && isUserId(roomId) && getState().roomMessages.roomId === roomId},
);

export const sendRoomMessage = createAsyncThunk<RoomMessage, {roomId: number; content: string}, ThunkConfig>(
    'roomMessages/send', async ({roomId, content}, {getState, dispatch, signal, requestId, rejectWithValue}) => {
        const auth = getState().auth;
        const current = () => !signal.aborted && getState().auth === auth
            && getState().roomMessages.roomId === roomId && getState().roomMessages.sendRequestId === requestId;
        try {
            const message = await api.sendRoomMessage(roomId, content, signal);
            if (!current()) return rejectWithValue({kind: 'superseded', message: 'Requête remplacée.'});
            if (message.senderId !== auth.user!.id) throw new Error('Invalid sender');
            return publicRoomMessage(message, roomId);
        } catch (error) {
            if (!current()) return rejectWithValue({kind: 'superseded', message: 'Requête remplacée.'});
            if (error instanceof DOMException && error.name === 'AbortError') throw error;
            if (error instanceof RoomApiError) {
                if (error.kind === 'unauthorized') { clearStoredSession(); dispatch(resetAuth()); }
                return rejectWithValue({kind: error.kind, message: error.message});
            }
            return rejectWithValue({kind: 'invalid', message: 'Envoi impossible. Veuillez réessayer.'});
        }
    }, {condition: ({roomId}, {getState}) => getState().auth.status === 'authenticated'
        && isUserId(roomId)
        && getState().roomMessages.roomId === roomId && getState().roomMessages.sendStatus !== 'loading'},
);

const roomMessagesSlice = createSlice({
    name: 'roomMessages', initialState,
    reducers: {
        openRoom: (_, action: PayloadAction<number>) => ({...initialState, roomId: action.payload}),
        clearRoomMessages: () => initialState,
    },
    extraReducers: builder => { builder
        .addCase(fetchRoomMessages.pending, (state, action) => {
            state.readStatus = 'loading'; state.readError = null;
            state.readRequestId = action.meta.requestId; state.confirmedDuringFetch = [];
        })
        .addCase(fetchRoomMessages.fulfilled, (state, action) => {
            if (state.readRequestId !== action.meta.requestId) return;
            state.items = chronologicalMessages([...action.payload, ...state.confirmedDuringFetch]);
            state.hasLoaded = true;
            state.confirmedDuringFetch = []; state.readRequestId = null; state.readStatus = 'succeeded';
        })
        .addCase(fetchRoomMessages.rejected, (state, action) => {
            if (state.readRequestId !== action.meta.requestId) return;
            state.readRequestId = null; state.confirmedDuringFetch = [];
            const cancelled = action.meta.aborted || action.payload?.kind === 'superseded';
            state.readStatus = cancelled ? 'idle' : 'failed';
            state.readError = cancelled ? null : action.payload?.message ?? 'Chargement impossible.';
        })
        .addCase(sendRoomMessage.pending, (state, action) => {
            state.sendStatus = 'loading'; state.sendError = null; state.sendRequestId = action.meta.requestId;
        })
        .addCase(sendRoomMessage.fulfilled, (state, action) => {
            if (state.sendRequestId !== action.meta.requestId) return;
            state.items = chronologicalMessages([...state.items, action.payload]);
            if (state.readStatus === 'loading') state.confirmedDuringFetch = chronologicalMessages([...state.confirmedDuringFetch, action.payload]);
            state.sendRequestId = null; state.sendStatus = 'succeeded';
        })
        .addCase(sendRoomMessage.rejected, (state, action) => {
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
export const {openRoom, clearRoomMessages} = roomMessagesSlice.actions;
export default roomMessagesSlice.reducer;
