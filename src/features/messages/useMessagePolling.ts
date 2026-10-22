import {useCallback, useEffect, useRef} from 'react';
import {useDispatch, useSelector, useStore} from 'react-redux';
import type {AppDispatch, RootState} from '../../app/store';
import {fetchMessages} from './messagesSlice';
import {fetchRoomMessages} from '../rooms/roomMessagesSlice';

export const MESSAGE_POLL_DELAY_MS = 8000;

export function useMessagePolling(recipientId: number, kind: 'private' | 'room' = 'private') {
    const dispatch = useDispatch<AppDispatch>();
    const store = useStore<RootState>();
    const auth = useSelector((state: RootState) => state.auth);
    const refresh = useRef<() => void>(() => {});

    useEffect(() => {
        if (auth.status !== 'authenticated' || !auth.user) return;
        let disposed = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let running = false;
        let waitingForRead = false;
        let interrupted = false;
        let resumeAfterFlight = false;
        let request: ReturnType<ReturnType<typeof fetchMessages>> | ReturnType<ReturnType<typeof fetchRoomMessages>> | undefined;

        const conversation = () => {
            const state = store.getState();
            return kind === 'room' ? {id: state.roomMessages.roomId, readStatus: state.roomMessages.readStatus}
                : {id: state.messages.userId, readStatus: state.messages.readStatus};
        };

        const current = () => !disposed && store.getState().auth === auth
            && conversation().id === recipientId;
        const available = () => current() && document.visibilityState !== 'hidden' && navigator.onLine !== false;
        const clearTimer = () => { clearTimeout(timer); timer = undefined; };
        const schedule = () => {
            clearTimer();
            if (available()) timer = setTimeout(() => { void run(); }, MESSAGE_POLL_DELAY_MS);
        };
        const run = async () => {
            clearTimer();
            if (!available() || running) return;
            if (conversation().readStatus === 'loading') {
                // Une lecture équivalente existe déjà : attendre sa fin via l'abonnement.
                waitingForRead = true;
                return;
            }
            waitingForRead = false;
            running = true;
            interrupted = false;
            resumeAfterFlight = false;
            request = kind === 'room' ? dispatch(fetchRoomMessages(recipientId)) : dispatch(fetchMessages(recipientId));
            await request; // Un thunk RTK retourne une action, même en cas d'échec.
            request = undefined;
            running = false;
            if (!available()) return;
            if (resumeAfterFlight) {
                resumeAfterFlight = false;
                void run();
            } else if (conversation().readStatus === 'loading') waitingForRead = true;
            else schedule();
        };
        const unsubscribe = store.subscribe(() => {
            if (!current()) {
                clearTimer();
                request?.abort();
                return;
            }
            if (running) return;
            if (conversation().readStatus === 'loading') {
                clearTimer();
                waitingForRead = true;
            } else if (waitingForRead) {
                waitingForRead = false;
                // Une lecture annulée pendant le nettoyage StrictMode ne retarde pas le remontage.
                if (conversation().readStatus === 'idle') void Promise.resolve().then(run);
                else schedule();
            }
        });
        const onAvailability = () => {
            if (!available()) {
                clearTimer();
                if (request) { interrupted = true; request.abort(); }
            } else if (running) {
                if (interrupted) resumeAfterFlight = true;
            } else void run();
        };

        refresh.current = () => { void run(); };
        document.addEventListener('visibilitychange', onAvailability);
        window.addEventListener('offline', onAvailability);
        window.addEventListener('online', onAvailability);
        void run();
        return () => {
            disposed = true;
            refresh.current = () => {};
            clearTimer();
            unsubscribe();
            request?.abort();
            document.removeEventListener('visibilitychange', onAvailability);
            window.removeEventListener('offline', onAvailability);
            window.removeEventListener('online', onAvailability);
        };
    }, [recipientId, kind, auth, dispatch, store]);

    return useCallback(() => refresh.current(), []);
}
