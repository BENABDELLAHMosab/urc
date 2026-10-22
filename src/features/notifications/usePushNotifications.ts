import {useEffect, useSyncExternalStore} from 'react';
import {useStore} from 'react-redux';
import type {RootState} from '../../app/store';
import {resetAuth} from '../auth/authSlice';
import {clearStoredSession} from '../../user/loginApi';
import {createPushController} from './pushController';

let invalidate = () => {};
const controller = createPushController({
    instanceId: import.meta.env.VITE_PUSHER_INSTANCE_ID ?? '',
    supported: () => typeof window !== 'undefined' && window.isSecureContext
        && 'Notification' in window && 'PushManager' in window && 'indexedDB' in window
        && 'serviceWorker' in navigator,
    permission: () => Notification.permission,
    requestPermission: () => Notification.requestPermission(),
    loadSDK: () => import('@pusher/push-notifications-web'),
    token: () => sessionStorage.getItem('token'),
    unauthorized: () => invalidate(),
});

// Abonnement global : le nettoyage fonctionne aussi sur une page de conversation ou de login.
export function usePushSession() {
    const store = useStore<RootState>();
    useEffect(() => {
        invalidate = () => { clearStoredSession(); store.dispatch(resetAuth()); };
        const sync = () => {
            const auth = store.getState().auth;
            // Ne pas effacer l'association avant le résultat de la restauration de session.
            if (auth.status !== 'checking') void controller.setIdentity(
                auth.status === 'authenticated' ? auth.user?.externalId ?? null : null);
        };
        sync();
        return store.subscribe(sync);
    }, [store]);
}

export function usePushNotifications() {
    const status = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
    const failure = useSyncExternalStore(controller.subscribe, controller.getFailureSnapshot, controller.getFailureSnapshot);
    return {status, failure, enable: controller.enable, disable: controller.disable};
}
