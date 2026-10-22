/* global PusherPushNotifications */
// Installé avant le SDK : son handler par défaut ne doit jamais ouvrir un deep_link arbitraire.
function privatePath(value) {
    if (typeof value !== 'string' || !/^\/messages\/user\/[1-9]\d*$/.test(value)) return '/messages';
    const id = Number(value.slice('/messages/user/'.length));
    return Number.isSafeInteger(id) && id <= 2147483647 ? value : '/messages';
}
self.addEventListener('notificationclick', event => {
    if (!event.notification.data?.pusher) return;
    event.stopImmediatePropagation();
    event.notification.close();
    const path = privatePath(event.notification.data.pusher.customerPayload?.data?.path);
    // L'application vérifie ensuite la session et ProtectedRoute protège toujours cette route.
    event.waitUntil(self.clients.openWindow(new URL(path, self.location.origin).href));
});

importScripts('https://js.pusher.com/beams/service-worker.js');
PusherPushNotifications.onNotificationReceived = ({pushEvent, payload, handleNotification}) => {
    // Conserver le handler officiel, mais limiter les données affichées et la destination.
    const safe = {notification: {title: 'UBO Relay Chat', body: 'Nouveau message privé.'},
        data: {path: privatePath(payload.data?.path)}};
    pushEvent.waitUntil(handleNotification(safe));
};
