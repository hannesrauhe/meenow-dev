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
// the new SW takes control loads the new hashed bundle, bypassing the browser
// HTML cache. Precache key is "index.html" (no leading slash).
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
  // Posted from the app the moment the user posts, so the pending reminder
  // disappears instead of waiting for the next tick's digest branch.
  if (event.data?.type === 'close-daily') event.waitUntil(closeDaily());
});

const ICON = '/icon-192.png';
const BADGE = '/badge-96.png';
const DAILY_TAG = 'meenow-daily';

// Escalating copy for the daily reminder: rung 0 is a period's first call, the
// last rung is the server-flagged evening "last call". The number of rungs IS
// the cap on visible reminders per period (see MAX_DAILY_REMINDERS), so editing
// this array moves both — keep them in sync by editing only here.
const DAILY_COPY = [
  'Time for your daily meenow!',
  'Your meenow is still waiting',
  'Last call \u2014 today\u2019s meenow',
];
const MAX_DAILY_REMINDERS = DAILY_COPY.length;

// App-icon badge alongside the daily reminder (installed PWAs on Android and
// iOS 16.4+; cleared by the app on open/post). Fire-and-forget where unsupported.
function setAppBadge(): void {
  const nav = self.navigator as WorkerNavigator & { setAppBadge?: (n?: number) => Promise<void> };
  void nav.setAppBadge?.(1).catch(() => {});
}

// Show a daily reminder, picking the next copy rung for this period. Only the
// first reminder of a period is audible: a same-tag replace re-alerts on Android
// unless silenced, and `renotify` is deliberately absent — re-alerting is the
// behaviour being removed here, not something to re-enable.
async function showDaily(triggerMs: number, lastCall: boolean): Promise<void> {
  const shown = (await idbGet<number>(IDB_KEYS.dailyShownTriggerMs)) ?? 0;
  const count = shown < triggerMs ? 0 : (await idbGet<number>(IDB_KEYS.dailyShownCount)) ?? 0;
  const rung = lastCall ? DAILY_COPY.length - 1 : Math.min(count, DAILY_COPY.length - 1);
  setAppBadge();
  await self.registration.showNotification('meenow', {
    body: DAILY_COPY[rung],
    icon: ICON,
    badge: BADGE,
    tag: DAILY_TAG,
    silent: count > 0,
    data: { action: 'capture' },
  });
  await idbSet(IDB_KEYS.dailyShownTriggerMs, triggerMs);
  await idbSet(IDB_KEYS.dailyShownCount, count + 1);
  await resetSilentCount();
}

// True while a daily reminder is still on screen. Fails visible (true) on error:
// an unreadable list must not buy us a silent push we cannot justify, matching
// trySilent's "cannot count — fail visible".
function dailyStillVisible(): Promise<boolean> {
  return self.registration
    .getNotifications({ tag: DAILY_TAG })
    .then(list => list.length > 0)
    .catch(() => true);
}

function closeDaily(): Promise<void> {
  return self.registration
    .getNotifications({ tag: DAILY_TAG })
    .then(list => list.forEach(n => n.close()))
    .catch(() => {});
}

// A period gets at most MAX_DAILY_REMINDERS visible reminders (first call, one
// reminder, last call) and never an identical duplicate. The cap counts *shown
// reminders*, never ticks: how many ticks fall in a period is an operator
// setting (the host cron interval, deduped only by the backend's slot bucket),
// so tick-based logic would break the moment that changes.
async function showDailyOrSkip(triggerMs: number, late: boolean): Promise<void> {
  const shown = (await idbGet<number>(IDB_KEYS.dailyShownTriggerMs)) ?? 0;
  if (shown < triggerMs) return showDaily(triggerMs, late);

  // The evening tick is a period's final rung by construction (timezone-correct
  // server-side), so it passes even once the cap is reached.
  if (late) return showDaily(triggerMs, true);

  const count = (await idbGet<number>(IDB_KEYS.dailyShownCount)) ?? 0;
  // At the cap, or still on screen: stay silent while the iOS budget allows, and
  // otherwise re-show the last rung — a same-tag replace still counts as
  // user-visible for WebKit's strike counter, which is the point.
  if (count >= MAX_DAILY_REMINDERS || (await dailyStillVisible())) {
    return (await trySilent()) ? undefined : showDaily(triggerMs, false);
  }
  return showDaily(triggerMs, false);
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
  // The user posted: a reminder still sitting in the shade is stale now.
  await closeDaily();
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
  await (notPosted ? showDailyOrSkip(triggerMs, late) : showPostPostedDigest(triggerMs, late));
}

self.addEventListener('push', event => {
  // json() throws on malformed payloads — swallow and treat as a plain tick so
  // even a corrupt push cannot end silently.
  let data: { ts?: number; force?: boolean; late?: boolean } = {};
  try {
    data = event.data?.json() ?? {};
  } catch { /* malformed payload */ }

  if (data.force) {
    const forceTriggerMs = getLastTriggerTime().getTime();
    event.waitUntil(showDaily(forceTriggerMs, false).catch(err => console.error('[sw] push handler failed', err)));
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
  // The daily reminder carries { action: 'capture' } so a tap opens the capture
  // screen directly (issue #56); other notifications open the feed.
  const action = (event.notification.data as { action?: string } | undefined)?.action;
  const url = action === 'capture' ? '/?action=capture' : '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      for (const client of clients) {
        if ('focus' in client) {
          client.focus();
          // Focusing alone can't reroute the in-memory SPA, so signal the intent.
          if (action) client.postMessage({ type: 'notification-action', action });
          return;
        }
      }
      return self.clients.openWindow(url);
    }).catch(err => console.error('[sw] notificationclick failed', err))
  );
});
