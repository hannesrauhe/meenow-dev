// Applying group events, shared by the app (catch-up on open / foreground) and
// the service worker (push). Both paths must end in the same state — a device
// that received a push and one that only polled next morning must agree about who
// is in the circle — so the loop lives here once rather than twice.
//
// The server is the only thing that knows an event happened; it holds no instance
// credentials, so every consequence (approve, follow back, sever) is applied here,
// on this device, with this user's token.
import type { AuthState } from './authState';
import { idbGet, idbSet, IDB_KEYS } from '../idb';
import { fetchGroupEvents, type GroupEvent, type GroupEventPage } from './groups';
import { applyJoinEvent, applyRemoveEvent } from './groupAuto';

// A ban is a (group, account) pair. Stored as a flat string so it survives
// IndexedDB round-trips without a schema.
const banKey = (groupId: string, account: string): string => `${groupId}\u0000${account}`;

export async function loadBans(): Promise<Set<string>> {
  const stored = await idbGet<string[]>(IDB_KEYS.groupBans).catch(() => undefined);
  return new Set(Array.isArray(stored) ? stored : []);
}

export function isBanned(bans: Set<string>, groupId: string, account: string): boolean {
  return bans.has(banKey(groupId, account));
}

// Highest event id this device has already acted on.
export async function lastSeenEventId(): Promise<number> {
  return (await idbGet<number>(IDB_KEYS.groupEventSeen).catch(() => undefined)) ?? 0;
}

// Pull whatever this device has not acted on yet and apply it, oldest first.
//
// Ascending order matters: a join followed by a removal must end with the person
// severed, not approved. Descending would leave them connected until the next
// correction, and "removed but still in the circle" is exactly the failure a kick
// is supposed to prevent.
//
// `onEvent` lets the service worker surface a notification per event; the app
// passes nothing, because a user looking at the screen does not need to be told
// about things that happened while they were away — the circle they open shows it.
export async function catchUpGroupEvents(
  auth: AuthState,
  onEvent?: (event: GroupEvent, skipped: boolean) => void,
): Promise<number> {
  const since = await lastSeenEventId();
  let page: GroupEventPage;
  try {
    page = await fetchGroupEvents(auth, since);
  } catch {
    return 0; // backend unreachable — nothing applied, high-water mark untouched
  }

  const bans = await loadBans();
  for (const ban of page.bans) bans.add(banKey(ban.group_id, ban.account));

  let applied = 0;
  let highest = since;
  for (const event of page.events) {
    // A banned account is never approved, even though its join event is still in
    // the log: applying it would briefly reconnect someone the admin has since
    // evicted, and if this pass then died (rate limit, offline) that would stick.
    const skipped = event.kind === 'join' && isBanned(bans, event.group_id, event.account);
    if (!skipped) {
      const ok = event.kind === 'join'
        ? await applyJoinEvent(auth, event, true)
        : await applyRemoveEvent(auth, event);
      // A failed apply still advances the mark: the catch-up runs on every open,
      // and an event that permanently fails (a deactivated account) must not
      // stall the queue forever. Anything transient is retried by the Circle
      // screen's own one-tap Accept.
      if (!ok) console.warn('[groups] event', event.id, 'not fully applied');
    }
    applied++;
    highest = Math.max(highest, event.id);
    onEvent?.(event, skipped);
  }

  if (highest > since) await idbSet(IDB_KEYS.groupEventSeen, highest);
  await idbSet(IDB_KEYS.groupBans, [...bans]).catch(() => {});
  return applied;
}

// Record an event the push handler acted on immediately, so the next catch-up
// does not do it again. Only ever moves forward.
export async function markEventSeen(id: number): Promise<void> {
  const seen = await lastSeenEventId();
  if (id > seen) await idbSet(IDB_KEYS.groupEventSeen, id);
}

// The retry ladder for a live push. Federation is not instant: the joiner's
// follow request may still be in flight when their join notification lands, so a
// single attempt would approve nothing and the newcomer would sit unconnected
// until the next app open. Attempts are cheap (one inbox read each) and the last
// one is flagged `final`, which is when we stop waiting and follow them ourselves.
const RETRY_DELAYS_MS = [0, 8_000, 25_000];

function wait(ms: number): Promise<void> {
  return ms === 0 ? Promise.resolve() : new Promise(resolve => setTimeout(resolve, ms));
}

export async function applyEventWithRetry(
  auth: AuthState,
  event: GroupEvent,
  bans: Set<string>,
): Promise<boolean> {
  if (event.kind === 'join' && isBanned(bans, event.group_id, event.account)) return true;
  for (let i = 0; i < RETRY_DELAYS_MS.length; i++) {
    await wait(RETRY_DELAYS_MS[i]);
    const final = i === RETRY_DELAYS_MS.length - 1;
    const ok = event.kind === 'join'
      ? await applyJoinEvent(auth, event, final)
      : await applyRemoveEvent(auth, event);
    if (ok) {
      await markEventSeen(event.id);
      return true;
    }
  }
  return false;
}
