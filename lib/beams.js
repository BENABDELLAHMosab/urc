// Importé exclusivement par les fonctions Node, jamais par React.
import PushNotifications from '@pusher/push-notifications-server';
// Le chargement natif évite aussi de tracer le fichier privé dans les bundles serveur.
function loadLocalDevelopmentConfig() {
    // La CLI locale transmet toujours NOW_REGION=dev1 aux fonctions ;
    // VERCEL_ENV peut n'être fourni qu'au processus Vite / de compilation.
    const development = process.env.VERCEL_ENV === 'development' || process.env.NOW_REGION === 'dev1';
    if (!development || process.env.VERCEL_ENV === 'production' || process.env.NODE_ENV === 'production') return;
    try {
        // Les valeurs héritées non vides restent prioritaires ; les emplacements vides
        // ne doivent pas masquer la configuration locale pendant le développement.
        for (const key of ['PUSHER_INSTANCE_ID', 'PUSHER_SECRET_KEY']) {
            if (!process.env[key]?.trim()) delete process.env[key];
        }
        process.loadEnvFile('.env.local');
    } catch {
        // Fichier absent / illisible : dégradation habituelle, sans log sensible.
    }
}

export function getBeamsClient() {
    if (!process.env.PUSHER_INSTANCE_ID?.trim() || !process.env.PUSHER_SECRET_KEY?.trim()) {
        loadLocalDevelopmentConfig();
    }
    const instanceId = process.env.PUSHER_INSTANCE_ID;
    const secretKey = process.env.PUSHER_SECRET_KEY;
    if (!instanceId?.trim() || !secretKey?.trim()) return null;
    return new PushNotifications({instanceId, secretKey});
}

export async function notifyPrivateMessage(recipient, senderId) {
    try {
        const client = getBeamsClient();
        if (!client || typeof recipient.external_id !== 'string' || !recipient.external_id.trim()) return;
        // La destination est construite depuis la session validée, jamais depuis le corps client.
        const path = `/messages/user/${senderId}`;
        let timer;
        try {
            // Le SDK installé n'a pas de timeout configurable. On borne l'attente HTTP,
            // sans relancer la publication. La requête SDK peut encore finir en arrière-plan.
            await Promise.race([
                client.publishToUsers([recipient.external_id], {web: {
                    notification: {title: 'UBO Relay Chat', body: 'Nouveau message privé.'},
                    data: {path},
                }}),
                new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('PUSH_TIMEOUT')), 3000); }),
            ]);
        } finally {
            clearTimeout(timer);
        }
    } catch {
        // Ni erreur fournisseur brute, ni identifiant, ni contenu privé.
        console.warn('Notification privée non publiée ou non confirmée.');
    }
}
