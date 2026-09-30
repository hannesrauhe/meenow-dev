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
import { applyEventWithRetry, loadBans, lastSeenEventId } from './api/groupEvents';
import type { GroupEvent, PushGroupEvent } from './api/groups';

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
  'Last call: today\u2019s meenow',
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
    body: "You're done for today. See what friends shared",
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
      body: `${parts.join(' · ')} on meenow posts`,
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
        body: `${plural(friends, 'friend', 'friends')} posted today. Open meenow`,
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

// A group event, pushed the moment another member's device writes it. Two jobs:
// tell the human what happened, and do the part only this device can do — the
// server holds no instance credentials, so approving a newcomer's follow request
// or severing a removed one has to happen here, with this user's token.
//
// The notification and the work are deliberately independent: the message is
// shown first (it is the user-visible half, and iOS counts silent pushes), then
// the graph is fixed whether or not that succeeds. A failure here is not lost —
// the events endpoint replays anything missed on the next app open.
async function handleGroupEvent(e: PushGroupEvent): Promise<void> {
  const auth = await idbGet<StoredAuth>(IDB_KEYS.auth);
  const me = auth ? `${auth.instance}:${auth.accountId}` : '';

  // The subject of a removal is told about it; nobody else's notification should
  // read like it happened to them. A removal the admin's own device caused is
  // also quiet — they just tapped Remove, and a push saying "you removed bob" is
  // noise. The work below still runs: this device has to sever the follow too,
  // and it is the only thing holding the admin's token.
  const removedMe = e.kind === 'remove' && e.account === me;
  const causedByMe = e.kind === 'remove' && e.actor === me;
  const body = e.kind === 'join'
    ? `${shortHandle(e.acct)} joined ${e.name}`
    : removedMe
      ? `You’re no longer part of ${e.name}`
      : `${shortHandle(e.acct)} was removed from ${e.name}`;

  // Tagged per event so a re-announce of the same event replaces the existing
  // notification instead of stacking a second copy of it.
  if (!causedByMe) {
    await self.registration.showNotification('meenow', {
      body,
      icon: ICON,
      badge: BADGE,
      tag: `meenow-group-${e.id}`,
      data: { action: 'circle' },
    });
    // A visible notification resets the iOS silent-push strike count; not doing
    // this would let group pushes starve the daily reminder's budget.
    await resetSilentCount();
  }

  if (!auth) return;
  // Already handled (push + catch-up can both deliver one event) — do nothing.
  if (e.id <= await lastSeenEventId()) return;

  const bans = await loadBans();
  // A removal is instant; a join rides the retry ladder, because the joiner's own
  // follow request is usually still in flight when this push lands.
  const event: GroupEvent = {
    id: e.id, group_id: e.group, kind: e.kind,
    account: e.account, acct: e.acct, actor: e.actor, name: e.name,
  };
  await applyEventWithRetry(auth, event, bans);
}

// "alice@pixelfed.social" -> "alice" — a notification body reads better without
// the domain, which is noise inside a small community.
function shortHandle(acct: string): string {
  return acct.replace(/^@/, '').split('@')[0] || acct;
}

// Activate a waiting update on push — the moment right before the user opens
// the app, and the only wake-up iOS reliably gives. Never rejects: a failed
// update check must not fail the push. The running app is not reloaded;
// skipWaiting + clientsClaim only change what the next open gets.
async function activateNewSW(updateCheck: Promise<void>): Promise<void> {
  const reg = self.registration;
  await updateCheck;
  if (reg.waiting) {
    reg.waiting.postMessage({ type: 'SKIP_WAITING' });
    return;
  }
  // Still downloading: wait for 'installed' (where it becomes reg.waiting),
  // capped so a slow network just leaves the update to the banner path.
  const sw = reg.installing;
  if (!sw) return;
  await new Promise<void>(resolve => {
    const timer = setTimeout(resolve, 15000);
    sw.addEventListener('statechange', () => {
      if (sw.state === 'installed') {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  // Re-read: the waiting worker only exists after the await above.
  self.registration.waiting?.postMessage({ type: 'SKIP_WAITING' });
}

self.addEventListener('push', event => {
  // json() throws on malformed payloads — swallow and treat as a plain tick so
  // even a corrupt push cannot end silently.
  let data: { ts?: number; force?: boolean; late?: boolean; message?: string; group_event?: PushGroupEvent } = {};
  try {
    data = event.data?.json() ?? {};
  } catch { /* malformed payload */ }

  // Re-fetch sw.js now so the new bundle downloads while the notification shows.
  const updateCheck = self.registration.update().then(() => {}).catch(() => {});

  // Group events MUST be branched on before anything else: an unrecognised
  // payload falls through to handleTick, which would render "b joined the group"
  // as a "time to post" reminder — wrong message, wrong reason, and the actual
  // work (approve/sever) would never run.
  let work: Promise<void>;
  if (data.group_event) {
    work = handleGroupEvent(data.group_event)
      .catch(err => console.error('[sw] group event failed', err));
  } else if (typeof data.message === 'string' && data.message) {
    // Operator broadcast (cron ?message=): show the text verbatim, always
    // visible — it is an explicit admin action, not a budgeted tick.
    work = self.registration
      .showNotification('meenow', {
        body: data.message,
        icon: ICON,
        badge: BADGE,
        tag: 'meenow-broadcast',
      })
      .then(resetSilentCount)
      .catch(err => console.error('[sw] broadcast failed', err));
  } else {
    // A force push (server-side test bypass) is a plain tick here: same gates,
    // same digest. Ticks with value always show; no-value ticks (pre-trigger, or
    // post-posting with nothing to report — including errors) consume the
    // counted silent budget and only surface the fallback once it is exhausted.
    work = handleTick(data.late === true)
      .catch(() => showFallbackOrSilent())
      .catch(err => console.error('[sw] push handler failed', err));
  }
  // Activation last: skipWaiting terminates this worker, so it must not fire
  // while the notification or the group-event retry ladder is still running.
  event.waitUntil(work.then(() => activateNewSW(updateCheck)));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  // The daily reminder carries { action: 'capture' } so a tap opens the capture
  // screen directly (issue #56); a group event carries 'circle', because that is
  // where a newcomer appears and where a removal is visible. Anything else (and
  // any future action the app does not know) opens the feed.
  const action = (event.notification.data as { action?: string } | undefined)?.action;
  const url = action === 'capture' || action === 'circle' ? `/?action=${action}` : '/';
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
