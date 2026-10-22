import type * as Beams from '@pusher/push-notifications-web';

export type PushStatus = 'unconfigured' | 'unsupported' | 'disabled' | 'active' | 'denied' | 'busy' | 'error';
export type PushStage = 'permission' | 'initialization' | 'cleanup' | 'registration' | 'authentication' | 'association';
export interface PushFailure {stage: PushStage; httpStatus?: number; cleanupFailed: boolean;}
type SDK = typeof Beams;
interface Options {
    instanceId: string;
    supported(): boolean;
    permission(): NotificationPermission;
    requestPermission(): Promise<NotificationPermission>;
    loadSDK(): Promise<SDK>;
    token(): string | null;
    unauthorized(): void;
}

// Petit service externe à Redux : aucun token, device ID ou état du SDK dans le store.
export function createPushController(options: Options) {
    let status: PushStatus = 'disabled';
    let failure: PushFailure | null = null;
    let identity: string | null = null;
    let generation = 0;
    let client: Beams.Client | null = null;
    let sdk: SDK;
    let queue = Promise.resolve();
    const listeners = new Set<() => void>();
    const update = (value: PushStatus) => { status = value; listeners.forEach(listener => listener()); };
    const fail = (error: unknown, stage: PushStage, cleanupFailed = false) => {
        // Ne conserver que l'étape et un statut HTTP reconnu, jamais l'erreur brute du SDK.
        const match = error instanceof Error ? /^Unexpected status code ([45]\d{2}):/.exec(error.message) : null;
        failure = {stage, httpStatus: match ? Number(match[1]) : undefined, cleanupFailed};
        update('error');
    };
    const available = (): PushStatus => !options.instanceId.trim() ? 'unconfigured'
        : !options.supported() ? 'unsupported' : options.permission() === 'denied' ? 'denied' : 'disabled';
    const enqueue = (work: () => Promise<void>, stage: PushStage = 'initialization') => {
        queue = queue.then(work).catch(error => fail(error, stage));
        return queue;
    };
    const getClient = async () => {
        if (!client) {
            sdk = await options.loadSDK();
            client = new sdk.Client({instanceId: options.instanceId});
        }
        return client;
    };
    const stop = async () => {
        if (client) await client.stop(); // stop supprime l'association locale ET distante, sans redemander la permission.
    };

    return {
        subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
        getSnapshot: () => status,
        getFailureSnapshot: () => failure,
        setIdentity(next: string | null) {
            if (identity === next && generation > 0) return queue;
            identity = next;
            const version = ++generation;
            update(available());
            return enqueue(async () => {
                if (available() === 'unconfigured' || available() === 'unsupported') return;
                const current = await getClient();
                const previous = await current.getUserId();
                if (version !== generation) return;
                // Permet de retrouver un abonnement existant après restauration de session,
                // sans start(), setUserId() ni demande de permission automatique.
                if (next && previous === next && options.permission() === 'granted'
                    && await current.getDeviceId()) {
                    if (version === generation) update('active');
                }
                else {
                    try { await stop(); } catch (error) { fail(error, 'cleanup', true); return; }
                    if (version === generation) update(available());
                }
            });
        },
        enable() {
            const version = generation;
            const userId = identity;
            if (!userId || ['unconfigured', 'unsupported', 'denied'].includes(available()) || status === 'busy') return queue;
            update('busy');
            // Appelé immédiatement par le clic, avant toute attente réseau (Firefox).
            let permission: Promise<NotificationPermission | null>;
            try {
                permission = options.permission() === 'granted' ? Promise.resolve('granted')
                    : options.requestPermission().catch(() => null);
            } catch (error) {
                fail(error, 'permission');
                return queue;
            }
            return enqueue(async () => {
                let stage: PushStage = 'permission';
                try {
                    const result = await permission;
                    if (result !== 'granted') {
                        if (version === generation) {
                            if (result === null) fail(null, 'permission');
                            else update(available());
                        }
                        return;
                    }
                    if (version !== generation) return;
                    stage = 'initialization';
                    const current = await getClient();
                    // Un nettoyage ayant échoué doit réussir avant toute nouvelle association.
                    stage = 'cleanup';
                    await stop();
                    if (version !== generation) return;
                    stage = 'registration';
                    await current.start();
                    const valid = () => version === generation && identity === userId;
                    if (!valid()) { await stop(); return; }
                    stage = 'association';
                    await current.setUserId(userId, {async fetchToken(requested) {
                        stage = 'authentication';
                        if (!valid() || requested !== userId) throw new Error('STALE_PUSH_REQUEST');
                        const token = options.token();
                        if (!token) throw new Error('MISSING_SESSION');
                        // Le provider officiel reste seul responsable du format de la requête.
                        const provider = new sdk.TokenProvider({url: '/api/beams',
                            headers: {Authorization: `Bearer ${token}`}});
                        try {
                            const result = await provider.fetchToken(requested);
                            if (!valid() || options.token() !== token) throw new Error('STALE_PUSH_REQUEST');
                            stage = 'association';
                            return result;
                        } catch (error) {
                            // Le SDK expose le statut HTTP uniquement dans ce message d'erreur.
                            if (valid() && options.token() === token && error instanceof Error && /^Unexpected status code 401:/.test(error.message)) options.unauthorized();
                            throw error;
                        }
                    }});
                    if (!valid()) { await stop(); return; }
                    update('active');
                } catch (error) {
                    let cleanupFailed = false;
                    try { await stop(); } catch { cleanupFailed = true; }
                    if (version === generation) {
                        if (!cleanupFailed && error instanceof Error && /^Unexpected status code 503: PUSH_NOT_CONFIGURED,/.test(error.message)) update('unconfigured');
                        else fail(error, stage, cleanupFailed);
                    }
                }
            });
        },
        disable() {
            const version = ++generation;
            update('busy');
            return enqueue(async () => {
                await stop();
                if (version === generation) update(available());
            }, 'cleanup');
        },
    };
}
