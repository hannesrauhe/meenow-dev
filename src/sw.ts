import { precacheAndRoute } from 'workbox-precaching';
import { getLastTriggerTime } from './timer';

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ revision: string | null; url: string }>;
};

precacheAndRoute(self.__WB_MANIFEST);

let lastNotifiedTriggerMs = 0;

self.addEventListener('push', event => {
  const now = Date.now();
  const triggerMs = getLastTriggerTime().getTime();
  const windowMs = 30 * 60 * 1000;

  // Only show if within the 30-min window after the trigger fires
  if (now < triggerMs || now > triggerMs + windowMs) return;
  // Deduplicate: only one notification per trigger period
  if (lastNotifiedTriggerMs >= triggerMs) return;
  lastNotifiedTriggerMs = triggerMs;

  event.waitUntil(
    self.registration.showNotification('meenow', {
      body: 'Time for your daily meenow!',
      icon: '/icon.svg',
      tag: 'meenow-daily',
    })
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
