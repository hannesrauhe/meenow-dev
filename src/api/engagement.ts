// SW-safe Pixelfed reads used by the push handler to build post-posting digests.
// Pure fetch only — no DOM or localStorage — so it can run inside the service worker.
import { getLastTriggerTime } from '../timer';
import { apiBase } from '../config';
import { idbGet, idbSet, IDB_KEYS, type StoredAuth } from '../idb';

interface NotifStatus {
  id?: string;
  tags?: { name: string }[];
  in_reply_to_id?: string | null;
}

// A status trimmed to what the reply-chain walk needs.
interface StatusLite {
  in_reply_to_id?: string | null;
  tags?: { name: string }[];
}

// Reply-chain walk depth and cache size caps. The depth matches the intuition
// that comments land on recent posts; the cache cap bounds growth by FIFO.
const MEENOW_WALK_MAX = 10;
const MEENOW_CACHE_MAX = 200;

interface MastodonNotification {
  id: string;
  type: string;
  status?: NotifStatus;
}

interface TimelineStatus {
  created_at: string;
  account: { id: string };
  media_attachments: unknown[];
  tags: { name: string }[];
}

function hasMeenowTag(tags?: { name: string }[]): boolean {
  return !!tags?.some(t => t.name.toLowerCase() === 'meenowapp');
}

// Fetch a single status, trimmed. Null on any failure (caller treats as unknown).
async function fetchStatusLite(auth: StoredAuth, id: string): Promise<StatusLite | null> {
  try {
    const res = await fetch(`${apiBase(auth.instance)}/api/v1/statuses/${id}`, {
      headers: { Authorization: `Bearer ${auth.accessToken}` },
      cache: 'no-store',
    });
    return res.ok ? (await res.json() as StatusLite) : null;
  } catch {
    return null;
  }
}

// Is the conversation this notification status belongs to rooted at a
// #meenowApp post? Walks up the reply chain so a reply to the user's own
// comment on someone else's meenow still counts. Each visited id's verdict is
// cached, so a known root ends the walk for every later reply to that post.
// A fetch failure stops unresolved (nothing cached) rather than guessing false.
async function resolveMeenow(
  auth: StoredAuth,
  leaf: NotifStatus,
  cache: Map<string, boolean>,
): Promise<boolean> {
  const visited: string[] = leaf.id ? [leaf.id] : [];
  if (hasMeenowTag(leaf.tags)) {
    for (const id of visited) cache.set(id, true);
    return true;
  }
  let parentId = leaf.in_reply_to_id ?? null;
  for (let depth = 0; depth < MEENOW_WALK_MAX && parentId; depth++) {
    const cached = cache.get(parentId);
    if (cached !== undefined) {
      for (const id of visited) cache.set(id, cached);
      return cached;
    }
    const parent = await fetchStatusLite(auth, parentId);
    if (!parent) return false;
    visited.push(parentId);
    if (hasMeenowTag(parent.tags)) {
      for (const id of visited) cache.set(id, true);
      return true;
    }
    parentId = parent.in_reply_to_id ?? null;
  }
  // Only a true root (no parent) proves the thread is not a meenow one; a walk
  // stopped by the depth cap stays uncached so a deeper root can still resolve.
  if (!parentId) for (const id of visited) cache.set(id, false);
  return false;
}

export interface NewEngagement {
  likes: number;
  reblogs: number;
  replies: number;
  newestId?: string;
}

// Reactions on meenow posts since the last seen notification: likes/reblogs on
// the user's own tagged posts, replies anywhere in a meenow-rooted thread.
// Returns zero counts (and no newestId) when the endpoint is unavailable.
export async function fetchNewEngagement(auth: StoredAuth, sinceId?: string): Promise<NewEngagement> {
  const empty: NewEngagement = { likes: 0, reblogs: 0, replies: 0 };
  const params = new URLSearchParams({ limit: '40' });
  if (sinceId) params.set('since_id', sinceId);
  try {
    const res = await fetch(`${apiBase(auth.instance)}/api/v1/notifications?${params}`, {
      headers: { Authorization: `Bearer ${auth.accessToken}` },
    });
    if (!res.ok) return empty;
    const notifs = await res.json() as MastodonNotification[];
    if (!Array.isArray(notifs) || notifs.length === 0) return empty;

    const cache = new Map<string, boolean>(
      (await idbGet<[string, boolean][]>(IDB_KEYS.meenowPostCache)) ?? [],
    );
    let likes = 0;
    let reblogs = 0;
    let replies = 0;
    let touched = false;
    for (const n of notifs) {
      if (n.type === 'favourite' || n.type === 'reblog') {
        if (!hasMeenowTag(n.status?.tags)) continue;
        if (n.type === 'favourite') likes++; else reblogs++;
      } else if (n.type === 'mention' && n.status) {
        touched = true;
        if (await resolveMeenow(auth, n.status, cache)) replies++;
      }
    }
    if (touched) {
      const entries = [...cache];
      if (entries.length > MEENOW_CACHE_MAX) entries.splice(0, entries.length - MEENOW_CACHE_MAX);
      await idbSet(IDB_KEYS.meenowPostCache, entries);
    }
    return { likes, reblogs, replies, newestId: notifs[0].id };
  } catch {
    return empty;
  }
}

// Distinct accounts other than the user that posted a meenow in the current period.
export async function fetchFriendsPostedCount(auth: StoredAuth): Promise<number> {
  const cutoff = getLastTriggerTime().getTime();
  try {
    // no-store keeps this SW-side fetch from reading or repopulating the HTTP
    // cache entry for the same URL the app's feed load uses.
    const res = await fetch(`${apiBase(auth.instance)}/api/v1/timelines/home?limit=40`, {
      headers: { Authorization: `Bearer ${auth.accessToken}` },
      cache: 'no-store',
    });
    if (!res.ok) return 0;
    const statuses = await res.json() as TimelineStatus[];
    if (!Array.isArray(statuses)) return 0;
    const accounts = new Set<string>();
    for (const s of statuses) {
      if (
        s.account.id !== auth.accountId &&
        new Date(s.created_at).getTime() >= cutoff &&
        s.media_attachments.length > 0 &&
        hasMeenowTag(s.tags)
      ) {
        accounts.add(s.account.id);
      }
    }
    return accounts.size;
  } catch {
    return 0;
  }
}
