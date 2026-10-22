import React from 'react';
import {usePushNotifications} from './usePushNotifications';

export function NotificationControls() {
    const {status, failure, enable, disable} = usePushNotifications();
    const labels = {
        unconfigured: 'Les notifications ne sont pas configurées.',
        unsupported: 'Ce navigateur ne prend pas en charge les notifications Web Push.',
        disabled: 'Notifications désactivées.', active: 'Notifications activées sur ce navigateur.',
        denied: 'Notifications refusées. Modifiez la permission dans les paramètres du navigateur pour les activer.',
        busy: 'Mise à jour des notifications…',
        error: 'Notifications indisponibles. Réessayez sur ce navigateur.',
    };
    const failures = {
        permission: 'Firefox ou le navigateur n’a pas pu demander l’autorisation.',
        initialization: 'Impossible de préparer les notifications dans ce navigateur. Vérifiez le service worker et les paramètres du site.',
        cleanup: 'Impossible de désassocier ce navigateur. Vérifiez la connexion avant de réessayer.',
        registration: 'Impossible d’enregistrer ce navigateur auprès de Pusher. Vérifiez la connexion et les permissions du navigateur.',
        authentication: 'Impossible d’obtenir l’autorisation de notification auprès du serveur URC.',
        association: 'Pusher n’a pas pu associer ce navigateur à votre compte.',
    };
    return <section aria-label="Notifications">
        <h2>Notifications</h2>
        <p role="status">{labels[status]}</p>
        {status === 'error' && failure && <div role="alert">
            <p>{failures[failure.stage]}{failure.httpStatus ? ` (HTTP ${failure.httpStatus})` : ''}</p>
            {failure.cleanupFailed && failure.stage !== 'cleanup' && <p>La désassociation a également échoué ; réessayez sur ce navigateur avant de changer de compte.</p>}
        </div>}
        {(status === 'disabled' || status === 'error') && <button onClick={() => void enable()}>Activer les notifications</button>}
        {(status === 'active' || status === 'error') && <button onClick={() => void disable()}>Désactiver les notifications</button>}
    </section>;
}
