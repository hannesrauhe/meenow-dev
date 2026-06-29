// Service worker: Workbox precache/route and push-notification handler.
import { clientsClaim } from 'workbox-core';
import {
  precacheAndRoute,
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
} from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { getLastTriggerTime } from './timer';
import { idbGet, idbSet, IDB_KEYS, type StoredAuth } from './idb';
import { fetchNewEngagement, fetchFriendsPostedCount } from './api/engagement';

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ revision: string | null; url: string }>;
};

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// Serve the freshly precached index.html for all navigations so a reload after
// the new SW takes control loads the new hashed bundle, bypassing the GitHub
// Pages / browser HTML cache. Precache key is "index.html" (no leading slash).
registerRoute(new NavigationRoute(createHandlerBoundToURL('index.html')));

// Take control of open clients on activate so skipWaiting() reloads the page
// (controllerchange fires) — otherwise the update banner's Refresh does nothing.
clientsClaim();

self.addEventListener('message', (event: ExtendableMessageEvent) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

const ICON = '/icon-192.png';
const BADGE = '/badge-96.png';

function showDaily(): Promise<void> {
  return self.registration.showNotification('meenow', {
    body: 'Time for your daily meenow!',
    icon: ICON,
    badge: BADGE,
    tag: 'meenow-daily',
  });
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

// Build a digest, or surface friends' activity, on a tick that would otherwise be
// silent because the user already posted. A real notification here replaces
// Chrome's generic "site updated" notification and keeps the push budget healthy.
async function showPostPostedDigest(triggerMs: number, now: number): Promise<void> {
  const auth = await idbGet<StoredAuth>(IDB_KEYS.auth);
  if (!auth) return;

  const lastSeenId = await idbGet<string>(IDB_KEYS.lastSeenNotifId);
  const digestShown = (await idbGet<number>(IDB_KEYS.digestShownTriggerMs)) ?? 0;

  const eng = await fetchNewEngagement(auth, lastSeenId);
  if (eng.likes + eng.reblogs + eng.replies > 0) {
    const parts: string[] = [];
    if (eng.likes) parts.push(plural(eng.likes, 'like', 'likes'));
    if (eng.reblogs) parts.push(plural(eng.reblogs, 'reblog', 'reblogs'));
    if (eng.replies) parts.push(plural(eng.replies, 'reply', 'replies'));
    await self.registration.showNotification('meenow', {
      body: `${parts.join(' · ')} on your meenow`,
      icon: ICON,
      badge: BADGE,
      tag: 'meenow-digest',
    });
    if (eng.newestId) await idbSet(IDB_KEYS.lastSeenNotifId, eng.newestId);
    await idbSet(IDB_KEYS.digestShownTriggerMs, triggerMs);
    return;
  }

  // Budget-safety fallback: once per period, on a late tick (final hour of the
  // daytime cron window, >= 19:00 UTC), surface how many friends posted.
  const lateTick = new Date(now).getUTCHours() >= 19;
  if (digestShown < triggerMs && lateTick) {
    const friends = await fetchFriendsPostedCount(auth);
    if (friends > 0) {
      await self.registration.showNotification('meenow', {
        body: `${plural(friends, 'friend', 'friends')} posted today — open meenow`,
        icon: ICON,
        badge: BADGE,
        tag: 'meenow-friends',
      });
      await idbSet(IDB_KEYS.digestShownTriggerMs, triggerMs);
    }
  }
}

self.addEventListener('push', event => {
  const data: { ts?: number; force?: boolean } = event.data?.json() ?? {};
  const now = Date.now();
  const triggerMs = getLastTriggerTime().getTime();

  // Skip ticks that arrive before the trigger (clock skew / early delivery).
  if (now < triggerMs && !data.force) return;

  if (data.force) {
    event.waitUntil(showDaily().catch(err => console.error('[sw] push handler failed', err)));
    return;
  }

  // Notify on every tick unless the user has already posted in this period.
  // idbGet reads the timestamp written by the app after a successful post.
  event.waitUntil(
    idbGet<number>(IDB_KEYS.postedTriggerMs)
      .then(posted => (posted ?? 0) < triggerMs)
      .catch(() => true)
      .then(notPosted => (notPosted ? showDaily() : showPostPostedDigest(triggerMs, now)))
      .catch(err => console.error('[sw] push handler failed', err))
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
    }).catch(err => console.error('[sw] notificationclick failed', err))
  );
});
