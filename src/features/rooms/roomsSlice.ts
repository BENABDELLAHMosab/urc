import {createAsyncThunk, createSlice} from '@reduxjs/toolkit';
import type {RootState} from '../../app/store';
import {resetAuth, setUser, startChecking, sessionUnavailable} from '../auth/authSlice';
import {clearStoredSession} from '../../user/loginApi';
import {getRooms, postRoom, RoomApiError} from './roomsApi';
import type {Room, RoomFailure} from './roomsApi';

type Status = 'idle' | 'loading' | 'succeeded' | 'failed';
interface RoomsState {
    items: Room[]; status: Status; error: string | null; requestId: string | null;
    createStatus: Status; createError: string | null; createRequestId: string | null;
    createdDuringFetch: Room[];
}
const initialState: RoomsState = {items: [], status: 'idle', error: null, requestId: null,
    createStatus: 'idle', createError: null, createRequestId: null, createdDuringFetch: []};
type Config = {state: RootState; rejectValue: RoomFailure};
const mergeRooms = (items: Room[]) => [...new Map(items.map(room => [room.room_id, room])).values()].sort((a, b) => a.room_id - b.room_id);

export const fetchRooms = createAsyncThunk<Room[], void, Config>('rooms/fetch', async (_, api) => {
    const auth = api.getState().auth;
    const current = () => !api.signal.aborted && api.getState().auth === auth && api.getState().rooms.requestId === api.requestId;
    try {
        const rooms = await getRooms(api.signal);
        if (!current()) return api.rejectWithValue({kind: 'superseded', message: 'Requête remplacée.'});
        return rooms;
    } catch (error) {
        if (!current()) return api.rejectWithValue({kind: 'superseded', message: 'Requête remplacée.'});
        if (error instanceof DOMException && error.name === 'AbortError') throw error;
        if (error instanceof RoomApiError) {
            if (error.kind === 'unauthorized') {clearStoredSession(); api.dispatch(resetAuth());}
            return api.rejectWithValue({kind: error.kind, message: error.message});
        }
        return api.rejectWithValue({kind: 'invalid', message: 'Chargement des salons impossible.'});
    }
}, {condition: (_, api) => api.getState().auth.status === 'authenticated'});

export const createRoom = createAsyncThunk<Room, string, Config>('rooms/create', async (name, api) => {
    const auth = api.getState().auth;
    const current = () => !api.signal.aborted && api.getState().auth === auth && api.getState().rooms.createRequestId === api.requestId;
    try {
        const room = await postRoom(name, api.signal);
        if (!current()) return api.rejectWithValue({kind: 'superseded', message: 'Requête remplacée.'});
        return room;
    } catch (error) {
        if (!current()) return api.rejectWithValue({kind: 'superseded', message: 'Requête remplacée.'});
        if (error instanceof DOMException && error.name === 'AbortError') throw error;
        if (error instanceof RoomApiError) {
            if (error.kind === 'unauthorized') {clearStoredSession(); api.dispatch(resetAuth());}
            return api.rejectWithValue({kind: error.kind, message: error.message});
        }
        return api.rejectWithValue({kind: 'invalid', message: 'Création du salon impossible.'});
    }
}, {condition: (_, api) => api.getState().auth.status === 'authenticated' && api.getState().rooms.createStatus !== 'loading'});

const roomsSlice = createSlice({name: 'rooms', initialState, reducers: {}, extraReducers: builder => {
    builder.addCase(fetchRooms.pending, (state, action) => {
        state.status = 'loading'; state.error = null; state.requestId = action.meta.requestId; state.createdDuringFetch = [];
    }).addCase(fetchRooms.fulfilled, (state, action) => {
        if (state.requestId !== action.meta.requestId) return;
        state.items = mergeRooms([...action.payload, ...state.createdDuringFetch]);
        state.status = 'succeeded'; state.requestId = null; state.createdDuringFetch = [];
    }).addCase(fetchRooms.rejected, (state, action) => {
        if (state.requestId !== action.meta.requestId) return;
        state.requestId = null; state.createdDuringFetch = [];
        const cancelled = action.meta.aborted || action.payload?.kind === 'superseded';
        state.status = cancelled ? 'idle' : 'failed'; state.error = cancelled ? null : action.payload?.message ?? 'Chargement impossible.';
    }).addCase(createRoom.pending, (state, action) => {
        state.createStatus = 'loading'; state.createError = null; state.createRequestId = action.meta.requestId;
    }).addCase(createRoom.fulfilled, (state, action) => {
        if (state.createRequestId !== action.meta.requestId) return;
        state.items = mergeRooms([...state.items, action.payload]);
        if (state.status === 'loading') state.createdDuringFetch = mergeRooms([...state.createdDuringFetch, action.payload]);
        state.createStatus = 'succeeded'; state.createRequestId = null;
    }).addCase(createRoom.rejected, (state, action) => {
        if (state.createRequestId !== action.meta.requestId) return;
        state.createRequestId = null;
        const cancelled = action.meta.aborted || action.payload?.kind === 'superseded';
        state.createStatus = cancelled ? 'idle' : 'failed'; state.createError = cancelled ? null : action.payload?.message ?? 'Création impossible.';
    }).addCase(resetAuth, () => initialState).addCase(setUser, () => initialState)
        .addCase(startChecking, () => initialState).addCase(sessionUnavailable, () => initialState);
}});
export default roomsSlice.reducer;
