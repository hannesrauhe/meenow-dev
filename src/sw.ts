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

// App-icon badge alongside the daily reminder (installed PWAs on Android and
// iOS 16.4+; cleared by the app on open/post). Fire-and-forget where unsupported.
function setAppBadge(): void {
  const nav = self.navigator as WorkerNavigator & { setAppBadge?: (n?: number) => Promise<void> };
  void nav.setAppBadge?.(1).catch(() => {});
}

function showDaily(): Promise<void> {
  setAppBadge();
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

// Minimal always-visible fallback for ticks with nothing better to say. Reuses
// the digest tag so repeated post-posting ticks replace instead of stacking; a
// replaced notification still counts as user-visible for the push budget. No
// app badge: the user already posted, so nothing is pending.
function showFallback(): Promise<void> {
  return self.registration.showNotification('meenow', {
    body: "You're done for today — see what friends shared",
    icon: ICON,
    badge: BADGE,
    tag: 'meenow-digest',
  });
}

// Build a digest, or surface friends' activity, on a tick after the user already
// posted. Must always end in a visible notification: iOS revokes the push
// subscription after three silent pushes, and Chrome drains the push budget.
async function showPostPostedDigest(triggerMs: number, late: boolean): Promise<void> {
  const auth = await idbGet<StoredAuth>(IDB_KEYS.auth);
  if (!auth) return showFallback();

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

  // Once per period, on the server-flagged late-evening tick, surface how many
  // friends posted (the flag is timezone-correct by construction server-side).
  if (late && digestShown < triggerMs) {
    const friends = await fetchFriendsPostedCount(auth);
    if (friends > 0) {
      await self.registration.showNotification('meenow', {
        body: `${plural(friends, 'friend', 'friends')} posted today — open meenow`,
        icon: ICON,
        badge: BADGE,
        tag: 'meenow-friends',
      });
      await idbSet(IDB_KEYS.digestShownTriggerMs, triggerMs);
      return;
    }
  }

  return showFallback();
}

async function handleTick(late: boolean): Promise<void> {
  const triggerMs = getLastTriggerTime().getTime();
  // idbGet reads the timestamp written by the app after a successful post.
  const notPosted = await idbGet<number>(IDB_KEYS.postedTriggerMs)
    .then(posted => (posted ?? 0) < triggerMs)
    .catch(() => true);
  // The server gates ticks to the post-trigger window per stored timezone, so a
  // pre-trigger arrival here (clock skew, stale timezone) is rare — showing the
  // reminder slightly early beats a silent push that burns the iOS budget.
  return notPosted ? showDaily() : showPostPostedDigest(triggerMs, late);
}

self.addEventListener('push', event => {
  // json() throws on malformed payloads — swallow and treat as a plain tick so
  // even a corrupt push cannot end silently.
  let data: { ts?: number; force?: boolean; late?: boolean } = {};
  try {
    data = event.data?.json() ?? {};
  } catch { /* malformed payload */ }

  if (data.force) {
    event.waitUntil(showDaily().catch(err => console.error('[sw] push handler failed', err)));
    return;
  }

  // Every non-force tick must end in a visible notification (never-silent rule).
  event.waitUntil(
    handleTick(data.late === true)
      .catch(() => showFallback())
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
