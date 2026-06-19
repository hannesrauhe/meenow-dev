// Service worker: Workbox precache/route and push-notification handler (shows notification only near the daily trigger time).
import { precacheAndRoute } from 'workbox-precaching';
import { getLastTriggerTime } from './timer';

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ revision: string | null; url: string }>;
};

precacheAndRoute(self.__WB_MANIFEST);

// How long after a trigger fires the SW will still show a notification.
// Matches the GitHub Actions cron interval so every tick lands in at most one window.
const NOTIFICATION_WINDOW_MS = 30 * 60 * 1000;

// In-memory dedup: prevents showing the same notification twice within a session.
// Resets if the SW is terminated and restarted — acceptable because the window
// will usually have expired before the next push arrives.
let lastNotifiedTriggerMs = 0;

self.addEventListener('message', (event: ExtendableMessageEvent) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('push', event => {
  const data: { ts?: number; force?: boolean } = event.data?.json() ?? {};
  const now = Date.now();
  const triggerMs = getLastTriggerTime().getTime();

  if (!data.force) {
    if (now < triggerMs || now > triggerMs + NOTIFICATION_WINDOW_MS) return;
    if (lastNotifiedTriggerMs >= triggerMs) return;
  }
  lastNotifiedTriggerMs = triggerMs;

  event.waitUntil(
    self.registration.showNotification('meenow', {
      body: 'Time for your daily meenow!',
      icon: '/icon-192.png',
      badge: '/badge-96.png',
      tag: 'meenow-daily',
    }).catch(err => console.error('[sw] showNotification failed', err))
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      for (const client of clients) {
        if ('focus' in client) { client.focus(); return; }
      }
      return self.clients.openWindow('/');
    })
  );
});
