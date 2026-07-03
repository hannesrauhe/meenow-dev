// Service worker: Workbox precache/route and push-notification handler.
import { clientsClaim } from 'workbox-core';
import {
  precacheAndRoute,
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
} from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { getLastTriggerTime, getTodayTrigger } from './timer';
import { idbGet, idbSet, IDB_KEYS, type StoredAuth } from './idb';
import { fetchNewEngagement, fetchFriendsPostedCount } from './api/engagement';

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ revision: string | null; url: string }>;
};

const manifest = self.__WB_MANIFEST;
precacheAndRoute(manifest);
cleanupOutdatedCaches();

// Serve the freshly precached index.html for all navigations so a reload after
// the new SW takes control loads the new hashed bundle, bypassing the GitHub
// Pages / browser HTML cache. Precache key is "index.html" (no leading slash).
// Guarded: in dev mode the manifest is empty and createHandlerBoundToURL would
// throw at evaluation time, aborting SW registration on the Vite dev server.
if (manifest.length) {
  registerRoute(new NavigationRoute(createHandlerBoundToURL('index.html')));
}

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
  }).then(resetSilentCount);
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

// Minimal visible fallback, shown only when the silent budget is exhausted.
// Reuses the digest tag so repeated fallbacks replace instead of stacking; a
// replaced notification still counts as user-visible for the push budget. No
// app badge: the user already posted, so nothing is pending.
function showFallback(): Promise<void> {
  return self.registration.showNotification('meenow', {
    body: "You're done for today — see what friends shared",
    icon: ICON,
    badge: BADGE,
    tag: 'meenow-digest',
  }).then(resetSilentCount);
}

// Build a digest, or surface friends' activity, on a tick after the user already
// posted. Ticks with nothing to report stay silent within the counted budget;
// once it is exhausted the minimal fallback shows (iOS three-strikes revocation).
async function showPostPostedDigest(triggerMs: number, late: boolean): Promise<void> {
  const auth = await idbGet<StoredAuth>(IDB_KEYS.auth);
  if (!auth) return showFallbackOrSilent();

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
    await resetSilentCount();
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
      await resetSilentCount();
      return;
    }
  }

  return showFallbackOrSilent();
}

// iOS/WebKit revokes the push subscription after three push events without a
// visible notification; showing one resets its strike count. Mirror that budget:
// no-value ticks may stay silent up to twice in a row, the third must show.
const MAX_SILENT_PUSHES = 2;

function resetSilentCount(): Promise<void> {
  return idbSet(IDB_KEYS.silentPushCount, 0).catch(() => {});
}

// Consume one unit of the silent budget. Returns false when the budget is
// exhausted — or when IndexedDB fails, since an uncounted silent push could be
// the one that gets the subscription revoked — meaning something must be shown.
async function trySilent(): Promise<boolean> {
  try {
    const silent = (await idbGet<number>(IDB_KEYS.silentPushCount)) ?? 0;
    if (silent < MAX_SILENT_PUSHES) {
      await idbSet(IDB_KEYS.silentPushCount, silent + 1);
      return true;
    }
  } catch { /* cannot count — fail visible */ }
  return false;
}

// A tick with nothing of value to report stays silent while the budget allows.
function showFallbackOrSilent(): Promise<void> {
  return trySilent().then(silent => (silent ? undefined : showFallback()));
}

async function handleTick(late: boolean): Promise<void> {
  const triggerMs = getLastTriggerTime().getTime();

  // Tick before today's trigger (clock skew, or a stale timezone gating the
  // server's send) means the device is still in the previous period's tail — a
  // notification now would be mistimed, so stay silent while the budget allows.
  if (Date.now() < getTodayTrigger().getTime() && (await trySilent())) return;

  // idbGet reads the timestamp written by the app after a successful post.
  const notPosted = await idbGet<number>(IDB_KEYS.postedTriggerMs)
    .then(posted => (posted ?? 0) < triggerMs)
    .catch(() => true);
  await (notPosted ? showDaily() : showPostPostedDigest(triggerMs, late));
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

  // Ticks with value always show; no-value ticks (pre-trigger, or post-posting
  // with nothing to report — including errors) consume the counted silent budget
  // and only surface the fallback once it is exhausted.
  event.waitUntil(
    handleTick(data.late === true)
      .catch(() => showFallbackOrSilent())
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
