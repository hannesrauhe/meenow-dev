// Service worker: Workbox precache/route and push-notification handler.
import { precacheAndRoute } from 'workbox-precaching';
import { getLastTriggerTime } from './timer';
import { idbGet } from './idb';

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ revision: string | null; url: string }>;
};

precacheAndRoute(self.__WB_MANIFEST);

self.addEventListener('message', (event: ExtendableMessageEvent) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('push', event => {
  const data: { ts?: number; force?: boolean } = event.data?.json() ?? {};
  const now = Date.now();
  const triggerMs = getLastTriggerTime().getTime();

  // Skip ticks that arrive before the trigger (clock skew / early delivery).
  if (now < triggerMs && !data.force) return;

  // Notify on every tick unless the user has already posted in this period.
  // idbGet reads the timestamp written by the app after a successful post.
  const shouldNotify = data.force
    ? Promise.resolve(true)
    : idbGet('posted-trigger-ms').then(posted => (posted ?? 0) < triggerMs);

  event.waitUntil(
    shouldNotify.then(should => {
      if (!should) return;
      return self.registration.showNotification('meenow', {
        body: 'Time for your daily meenow!',
        icon: '/icon-192.png',
        badge: '/badge-96.png',
        tag: 'meenow-daily',
      });
    }).catch(err => console.error('[sw] push handler failed', err))
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
